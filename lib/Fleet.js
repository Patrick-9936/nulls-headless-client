const path = require('node:path');
const fs = require('node:fs');
const Client = require('./Client');
const Actions = require('./Actions');
const Store = require('./Store');
const Protocol = require('./Protocol');
const TagCodec = require('../utils/TagCodec');
const { integer, target } = Protocol;

// Статус пишется не чаще 2 раз в секунду; раз в 30 с — heartbeat, даже без изменений.
const STATUS_INTERVAL = 500;
const STATUS_HEARTBEAT = 30000;
const COMMAND_SCAN_INTERVAL = 250;
const STALE_PROCESSING = 600000;

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
    }));
    for (const slot of this.slots) {
      let account;
      try {
        account = Store.read(path.join(root, 'accounts', `bot-${slot.index}.json`), {});
      } catch (error) {
        slot.status = 'failed';
        slot.error = `Повреждён accounts/bot-${slot.index}.json: ${error.message}`;
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
    };
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
    const payload = JSON.stringify({ ...data, updatedAt: null });
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
      client.on('state', ({ state, error }) => {
        if (this.clients.get(slot.index) !== client) return;
        slot.status = state;
        slot.error = error;
        slot.attempts = client.attempts || 0;
        this.snapshot();
      });
      client.on('warning', (error) => {
        if (this.clients.get(slot.index) !== client) return;
        slot.error = error.message;
        console.error(`bot=${slot.index} ${error.message}`);
      });
      client.on('account', (account) => {
        if (this.clients.get(slot.index) !== client) return;
        slot.registered = !!(account.passToken && (account.hi || account.lo));
        slot.name = account.name || null;
        slot.tag = account.lo ? TagCodec.logicLongToTag(account.hi, account.lo) : null;
        if (this.options.clubTag) slot.joined = Actions.same(account.club, target(this.options.clubTag));
        this.snapshot();
      });
      client.on('packet', () => {
        slot.lastServerAt = client.lastServerAt;
        slot.matchmaking = client.matchmaking || null;
      });
      connectDeadline = setTimeout(() => {
        if (initial) {
          client.close();
          slot.status = 'failed';
          slot.error = 'Вход/ник не подтверждены за 90 секунд';
        }
      }, 90000);
      connectDeadline.unref?.();
      const join = async () => {
        slot.onlineSince = client.onlineSince;
        slot.joined = false;
        if (!this.options.clubTag) return;
        slot.status = 'joining-club';
        try {
          if (!Actions.same(client.club, target(this.options.clubTag)))
            await Actions.execute(client, 'join-club', { clubTag: this.options.clubTag });
          slot.joined = Actions.same(client.club, target);
          slot.clubError = null;
        } catch (error) {
          slot.clubError = error.message;
          console.error(`bot=${slot.index} ${error.message}`);
        }
        slot.status = client.state;
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
      slot.error = error.message;
      const blocked = !!client?.permanentError;
      client?.close();
      slot.status = blocked ? 'blocked' : 'failed';
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
      const names = fs.readdirSync(this.commandDir).filter((n) => /^[a-f0-9-]+\.json$/.test(n));
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
              slot.status = 'queued';
              slot.error = null;
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
        } catch (error) {
          Store.write(resultFile, { ok: false, error: error.message });
        } finally {
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
    let names;
    try {
      names = fs.readdirSync(this.commandDir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.endsWith('.processing')) continue;
      const file = path.join(this.commandDir, name);
      try {
        if (now - fs.statSync(file).mtimeMs > STALE_PROCESSING) fs.unlinkSync(file);
      } catch {}
    }
  }
  async runOne(index, action, args) {
    const client = this.clients.get(index);
    if (!client || client.state !== 'online') return { index, error: 'Бот ещё не вошёл' };
    try {
      return { index, ...(await Actions.execute(client, action, args)) };
    } catch (error) {
      return { index, error: error.message };
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
    this.closed = true;
  }
}
module.exports = Fleet;
