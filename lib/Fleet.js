const path = require('node:path');
const fs = require('node:fs');
const Client = require('./Client');
const Actions = require('./Actions');
const Store = require('./Store');
const Accounts = require('./Accounts');
const Protocol = require('./Protocol');
const TagCodec = require('../utils/TagCodec');
const { codes, codeOf, toJSON } = require('./Errors');
const { integer, target } = Protocol;

// Статус пишется не чаще 2 раз в секунду; раз в 30 с — heartbeat, даже без изменений.
const STATUS_INTERVAL = 500;
const STATUS_HEARTBEAT = 30000;
const COMMAND_SCAN_INTERVAL = 250;
const STALE_PROCESSING = 600000;
const LOGIN_SAMPLES = 200;

// Признаки ошибки для статуса слота и файла результата: текст остаётся текстом,
// код/категория — отдельными полями, чтобы родитель отличал сеть от отказа сервера.
function errorInfo(error, fallback = {}) {
  if (error === undefined || error === null) return { message: null, code: null, kind: null, retryable: null };
  if (typeof error === 'string')
    return {
      message: error,
      code: fallback.code ?? null,
      kind: fallback.kind ?? null,
      retryable: fallback.retryable ?? null,
    };
  const safe = toJSON(error);
  return {
    message: error.message,
    code: fallback.code ?? codeOf(error),
    kind: fallback.kind ?? safe.kind,
    retryable: safe.retryable,
  };
}

function average(values) {
  if (!values.length) return null;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

// p95 по последним замерам входа; null, пока не было ни одного успешного входа.
function percentile(values, ratio) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index];
}

class Fleet {
  constructor(root, options = {}, ClientType = Client) {
    this.root = root;
    this.options = options;
    this.ClientType = ClientType;
    this.first = integer(options.first ?? 1, 'first', 1, 100000);
    this.count = integer(options.count ?? 1, 'count', 1, 100);
    this.concurrency = integer(options.concurrency ?? 3, 'concurrency', 1, 20);
    this.commandConcurrency = integer(options.commandConcurrency ?? 8, 'commandConcurrency', 1, 32);
    this.statusInterval = integer(options.statusInterval ?? STATUS_INTERVAL, 'statusInterval', 0, 60000);
    this.statusHeartbeat = integer(options.statusHeartbeat ?? STATUS_HEARTBEAT, 'statusHeartbeat', 1000, 3600000);
    this.commandScanInterval = integer(
      options.commandScanInterval ?? COMMAND_SCAN_INTERVAL,
      'commandScanInterval',
      0,
      60000,
    );
    this.clients = new Map();
    this.inflight = 0;
    this.stopping = false;
    this.paused = false;
    this.closed = false;
    this.processing = false;
    this.startedAt = Date.now();
    this.metrics = {
      loggedInTotal: 0,
      failedTotal: 0,
      loginTimes: [],
      launchAt: new Map(),
      commandOk: 0,
      commandError: 0,
      lastCommandAt: null,
    };
    this.registryWarned = false;
    this.commandWarned = false;
    this.runtime = path.join(root, '.runtime');
    this.commandDir = path.join(this.runtime, 'commands');
    this.statusFile = path.join(root, 'fleet-status.json');
    fs.mkdirSync(this.commandDir, { recursive: true });
    fs.mkdirSync(path.join(this.runtime, 'results'), { recursive: true });
    this.slots = Array.from({ length: this.count }, (_, n) => ({
      index: this.first + n,
      status: 'queued',
      registered: false,
      joined: false,
      attempts: 0,
      error: null,
      errorCode: null,
      errorKind: null,
      failureCounted: false,
      rttMs: null,
      rttSamples: 0,
    }));
    for (const slot of this.slots) {
      let account;
      try {
        account = Store.read(path.join(root, 'accounts', `bot-${slot.index}.json`), {});
      } catch (error) {
        const info = errorInfo(error);
        slot.status = 'failed';
        slot.error = `Повреждён accounts/bot-${slot.index}.json: ${error.message}`;
        slot.errorCode = info.code;
        slot.errorKind = info.kind;
        continue;
      }
      slot.registered = !!(account.passToken && (account.hi || account.lo));
      slot.name = account.name || null;
      slot.tag = account.lo ? TagCodec.logicLongToTag(account.hi, account.lo) : null;
    }
    this.readyCursor = 0;
    this.anyCursor = 0;
    this.flushTimer = null;
    this.lastWriteAt = 0;
    this.lastPayload = null;
    this.lastScanAt = 0;
  }
  statusData(updatedAt) {
    const states = {};
    for (const slot of this.slots) states[slot.status] = (states[slot.status] || 0) + 1;
    return {
      pid: process.pid,
      updatedAt,
      first: this.first,
      requested: this.count,
      clubTag: this.options.clubTag || null,
      states,
      creationPaused: this.paused ? 'Приостановлено командой пользователя' : null,
      bots: this.slots,
      metrics: this.metricsData(),
    };
  }
  // Все значения пересчитываются при записи статуса, не на каждый пакет.
  metricsData(now = Date.now()) {
    const loginTimes = this.metrics.loginTimes;
    // Среднее и сумма только по онлайн-слотам: у офлайна rttMs — последний известный
    // замер прошлой сессии, он не должен тянуть текущую метрику.
    const rtts = [];
    let rttSamples = 0;
    for (const slot of this.slots) {
      if (slot.status !== 'online' || !Number.isFinite(slot.rttMs)) continue;
      rtts.push(slot.rttMs);
      rttSamples += slot.rttSamples || 0;
    }
    return {
      startedAt: new Date(this.startedAt).toISOString(),
      uptimeSec: Math.max(0, Math.round((now - this.startedAt) / 1000)),
      totalBots: this.slots.length,
      registered: this.slots.filter((slot) => slot.registered).length,
      online: this.slots.filter((slot) => slot.status === 'online').length,
      loggedInTotal: this.metrics.loggedInTotal,
      failedTotal: this.metrics.failedTotal,
      avgLoginMs: average(loginTimes),
      p95LoginMs: percentile(loginTimes, 0.95),
      avgRttMs: average(rtts),
      rttSamples: rtts.length ? rttSamples : null,
      commands: {
        ok: this.metrics.commandOk,
        error: this.metrics.commandError,
        pending: this.pendingCommands(),
      },
      lastCommandAt: this.metrics.lastCommandAt,
    };
  }
  pendingCommands() {
    try {
      return fs.readdirSync(this.commandDir).filter((name) => /^[a-f0-9-]+\.json$/.test(name)).length;
    } catch {
      return 0;
    }
  }
  // Единственное место смены статуса слота: переход в failed/blocked считается один раз
  // на инцидент (slot.failureCounted), а не на каждое последующее событие того же сбоя.
  setStatus(slot, status, error, meta = {}) {
    const previous = slot.status;
    const info = errorInfo(error, meta);
    slot.status = status;
    slot.error = info.message;
    slot.errorCode = info.code;
    slot.errorKind = info.kind;
    if (['failed', 'blocked'].includes(status)) {
      if (!['failed', 'blocked'].includes(previous) && !slot.failureCounted) {
        this.metrics.failedTotal++;
        slot.failureCounted = true;
      }
    } else if (status === 'online' || status === 'queued') {
      // Слот снова живой (или явно перезапущен) — следующий сбой это новый инцидент.
      slot.failureCounted = false;
    }
    return previous;
  }
  // Учитываем вход один раз на переход в online; замер — от launch() до подтверждённого входа.
  recordLogin(slot) {
    this.metrics.loggedInTotal++;
    const started = this.metrics.launchAt.get(slot.index);
    if (!started) return;
    this.metrics.launchAt.delete(slot.index);
    this.metrics.loginTimes.push(Date.now() - started);
    if (this.metrics.loginTimes.length > LOGIN_SAMPLES) this.metrics.loginTimes.shift();
  }
  // Реестр — побочный индекс: любая его ошибка логируется один раз и не роняет флот.
  updateRegistry(slot, account, client) {
    try {
      const file = client?.file
        ? path.relative(this.root, client.file)
        : path.join('accounts', `bot-${slot.index}.json`);
      Accounts.upsert(this.root, account || {}, file);
    } catch (error) {
      if (this.registryWarned) return;
      this.registryWarned = true;
      global.Debugger?.warn?.(`реестр аккаунтов: ${error.message}`);
    }
  }
  // Публичный API сохранён: только помечает статус изменённым и планирует запись.
  snapshot() {
    if (this.closed) return;
    const now = Date.now();
    if (now - this.lastWriteAt >= this.statusHeartbeat) {
      this.flushStatus();
      return;
    }
    if (this.flushTimer) return;
    const delay = Math.max(0, this.statusInterval - (now - this.lastWriteAt));
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushStatus();
    }, delay);
    this.flushTimer.unref?.();
  }
  flushStatus(force = false) {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const now = Date.now();
    const data = this.statusData(new Date(now).toISOString());
    // В сравнение «изменилось ли состояние» не входит только uptimeSec: он растёт сам по себе,
    // иначе запись шла бы каждый интервал. pending и счётчики команд — реальные изменения.
    const comparable = { ...data, updatedAt: null, metrics: { ...data.metrics, uptimeSec: null } };
    const payload = JSON.stringify(comparable);
    // Содержимое не изменилось и heartbeat ещё не истёк — запись пропускается.
    if (!force && payload === this.lastPayload && now - this.lastWriteAt < this.statusHeartbeat) return false;
    Store.write(this.statusFile, data);
    this.lastPayload = payload;
    this.lastWriteAt = now;
    return true;
  }
  start() {
    this.closed = false;
    this.flushStatus(true);
    this.pump();
    this.timer = setInterval(() => {
      this.snapshot();
      this.processCommands().catch((error) => console.error(error.message));
    }, 1000);
  }
  // Курсор по кругу: сначала зарегистрированные боты, затем любой queued.
  nextQueued() {
    const total = this.slots.length;
    for (let n = 0; n < total; n++) {
      const i = (this.readyCursor + n) % total;
      if (this.slots[i].status === 'queued' && this.slots[i].registered) {
        this.readyCursor = (i + 1) % total;
        return this.slots[i];
      }
    }
    for (let n = 0; n < total; n++) {
      const i = (this.anyCursor + n) % total;
      if (this.slots[i].status === 'queued') {
        this.anyCursor = (i + 1) % total;
        return this.slots[i];
      }
    }
    return null;
  }
  pump() {
    if (this.stopping || this.paused) return;
    while (this.inflight < this.concurrency) {
      const slot = this.nextQueued();
      if (!slot) break;
      this.launch(slot);
    }
  }
  async launch(slot) {
    this.inflight++;
    this.metrics.launchAt.set(slot.index, Date.now());
    slot.status = 'connecting';
    let initial = true,
      client,
      connectDeadline;
    try {
      client = new this.ClientType({
        root: this.root,
        account: `accounts/bot-${slot.index}.json`,
        index: slot.index,
        name: slot.name || `${this.options.namePrefix ?? 'Bot'}${slot.index}`,
        reconnect: true,
        proxyFile: this.options.proxyFile,
        proxyPoolFile: this.options.proxyPoolFile,
        dump: this.options.dump,
        battleTransport: this.options.battleTransport,
      });
      this.clients.set(slot.index, client);
      client.peers = this.clients;
      client.on('state', ({ state, error, code, kind }) => {
        if (this.clients.get(slot.index) !== client) return;
        const previous = this.setStatus(slot, state, error, { code, kind });
        slot.attempts = client.attempts || 0;
        if (state === 'online' && previous !== 'online') this.recordLogin(slot);
        this.snapshot();
      });
      client.on('warning', (error) => {
        if (this.clients.get(slot.index) !== client) return;
        const info = errorInfo(error);
        slot.error = info.message;
        slot.errorCode = info.code;
        slot.errorKind = info.kind;
        console.error(`bot=${slot.index} ${error.message}`);
      });
      client.on('account', (account) => {
        if (this.clients.get(slot.index) !== client) return;
        slot.registered = !!(account.passToken && (account.hi || account.lo));
        slot.name = account.name || null;
        slot.tag = account.lo ? TagCodec.logicLongToTag(account.hi, account.lo) : null;
        if (this.options.clubTag) slot.joined = Actions.same(account.club, target(this.options.clubTag));
        this.updateRegistry(slot, account, client);
        this.snapshot();
      });
      client.on('packet', () => {
        slot.lastServerAt = client.lastServerAt;
        slot.matchmaking = client.matchmaking || null;
        slot.rttMs = Number.isFinite(client.rttMs) ? client.rttMs : null;
        slot.rttSamples = client.rttSamples || 0;
      });
      connectDeadline = setTimeout(() => {
        if (initial) {
          client.close();
          this.setStatus(slot, 'failed', 'Вход/ник не подтверждены за 90 секунд', {
            code: codes.TIMEOUT,
            kind: 'timeout',
          });
        }
      }, 90000);
      connectDeadline.unref?.();
      const join = async () => {
        slot.onlineSince = client.onlineSince;
        slot.joined = false;
        if (client.account) this.updateRegistry(slot, client.account, client);
        if (!this.options.clubTag) return;
        this.setStatus(slot, 'joining-club');
        try {
          if (!Actions.same(client.club, target(this.options.clubTag)))
            await Actions.execute(client, 'join-club', { clubTag: this.options.clubTag });
          slot.joined = Actions.same(client.club, target(this.options.clubTag));
          slot.clubError = null;
        } catch (error) {
          const info = errorInfo(error);
          slot.clubError = info.message;
          slot.clubErrorCode = info.code;
          slot.clubErrorKind = info.kind;
          console.error(`bot=${slot.index} ${error.message} (${info.code || info.kind || 'unknown'})`);
        }
        this.setStatus(slot, client.state);
        this.snapshot();
      };
      client.on('online', () => {
        if (this.clients.get(slot.index) !== client || this.stopping) return;
        if (!initial) join().catch((error) => console.error(error.message));
      });
      await client.connect();
      initial = false;
      clearTimeout(connectDeadline);
      await join();
    } catch (error) {
      initial = false;
      clearTimeout(connectDeadline);
      const blocked = !!client?.permanentError;
      client?.close();
      this.setStatus(slot, blocked ? 'blocked' : 'failed', error);
    } finally {
      this.inflight--;
      this.snapshot();
      this.pump();
    }
  }
  async processCommands() {
    if (this.processing || this.stopping) return;
    this.processing = true;
    try {
      const now = Date.now();
      if (now - this.lastScanAt < this.commandScanInterval) return;
      this.lastScanAt = now;
      this.cleanupStale(now);
      let names;
      try {
        names = fs.readdirSync(this.commandDir).filter((n) => /^[a-f0-9-]+\.json$/.test(n));
      } catch (error) {
        // Каталог могли удалить (cleanup, ручная чистка, смена прав) — пересоздаём и живём дальше.
        if (error.code === 'ENOENT') {
          try {
            fs.mkdirSync(this.commandDir, { recursive: true });
          } catch {}
        } else if (!this.commandWarned) {
          this.commandWarned = true;
          global.Debugger?.error?.(`каталог команд флота: ${error.message}`);
        }
        return;
      }
      for (const name of names) {
        const file = path.join(this.commandDir, name);
        // Атомарный захват: второй тик/процесс уже не увидит *.json.
        const claimed = `${file}.processing`;
        try {
          fs.renameSync(file, claimed);
        } catch {
          continue;
        }
        const resultFile = path.join(this.runtime, 'results', name);
        try {
          const item = Store.read(claimed);
          let result;
          if (item.action === 'pause') {
            this.paused = true;
            result = { paused: true };
          } else if (item.action === 'resume') {
            this.paused = false;
            this.pump();
            result = { paused: false };
          } else if (item.action === 'retry') {
            for (const slot of this.slots.filter((s) => ['failed', 'blocked'].includes(s.status))) {
              this.clients.get(slot.index)?.close();
              this.setStatus(slot, 'queued', null);
            }
            this.paused = false;
            this.pump();
            result = { retried: true };
          } else {
            const indexes = item.all
              ? this.slots.map((s) => s.index)
              : [integer(item.bot, 'bot', this.first, this.first + this.count - 1)];
            result = item.all
              ? await this.runAll(indexes, item.action, item.args)
              : [await this.runOne(indexes[0], item.action, item.args)];
          }
          Store.write(resultFile, { ok: true, result });
          this.metrics.commandOk++;
        } catch (error) {
          const info = errorInfo(error);
          Store.write(resultFile, {
            ok: false,
            error: info.message,
            code: info.code,
            kind: info.kind,
            retryable: info.retryable === true,
          });
          this.metrics.commandError++;
        } finally {
          this.metrics.lastCommandAt = new Date().toISOString();
          try {
            fs.unlinkSync(claimed);
          } catch {}
        }
      }
    } finally {
      this.processing = false;
    }
  }
  cleanupStale(now) {
    Accounts.removeStale(this.commandDir, { pattern: /\.processing$/, maxAge: STALE_PROCESSING, now });
  }
  async runOne(index, action, args) {
    const client = this.clients.get(index);
    if (!client || client.state !== 'online')
      return { index, error: 'Бот ещё не вошёл', code: codes.STATE_ERROR, kind: 'state', retryable: false };
    try {
      return { index, ...(await Actions.execute(client, action, args)) };
    } catch (error) {
      const info = errorInfo(error);
      return { index, error: info.message, code: info.code, kind: info.kind, retryable: info.retryable === true };
    }
  }
  // Ограниченный параллелизм; результаты остаются в порядке возрастания индексов.
  async runAll(indexes, action, args) {
    const results = new Array(indexes.length);
    let next = 0;
    const worker = async () => {
      while (next < indexes.length) {
        const i = next++;
        results[i] = await this.runOne(indexes[i], action, args);
      }
    };
    const workers = Math.min(this.commandConcurrency, indexes.length);
    await Promise.all(Array.from({ length: workers }, worker));
    return results;
  }
  stop() {
    this.stopping = true;
    clearInterval(this.timer);
    this.timer = null;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    for (const client of this.clients.values()) client.close();
    for (const slot of this.slots) slot.status = 'stopped';
    this.flushStatus(true);
    // Финальный flush реестра: иначе отложенная запись (до 5 с) теряется на SIGTERM/SIGINT.
    try {
      Accounts.flush(this.root);
    } catch (error) {
      global.Debugger?.warn?.(`реестр аккаунтов: ${error.message}`);
    }
    this.closed = true;
  }
}
module.exports = Fleet;
