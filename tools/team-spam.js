#!/usr/bin/env node
'use strict';
// Multi-session room driver: N accounts join one lobby by code, chat on a timer,
// and go permanently idle the moment the server removes them from the team.
const path = require('node:path');
const fs = require('node:fs');
const Client = require('../lib/Client');
const Actions = require('../lib/Actions');
const Store = require('../lib/Store');
const {parse} = require('../lib/Args');

const ROOT = path.resolve(__dirname, '..');
const RUNTIME = path.join(ROOT, '.runtime');
const ACCOUNTS = path.join(ROOT, 'accounts');
const STATE_FILE = path.join(RUNTIME, 'team-spam.json');

const TEAM_UPDATE = 24124;
const TEAM_CLOSED = 24125;
const TEAM_ERROR = 24129;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const accountFile = index => path.join(ACCOUNTS, `bot-${index}.json`);
const same = (a, b) => !!(a && b && a.hi === b.hi && a.lo === b.lo);

function log(scope, ...args) {
  console.log(new Date().toISOString(), `[${scope}]`, ...args);
}

function loadState() {
  const state = Store.read(STATE_FILE, {});
  state.kicked ||= {};
  state.stats ||= {};
  return state;
}

function saveState(state) {
  Store.write(STATE_FILE, state);
}

// Creates a guest session for a missing account file. The name is fixed at
// registration, so a rejection falls back to a numbered variant instead of retrying.
async function createAccount(index, options) {
  const names = [options.name, `${options.name}${index}`];
  let last;
  for (const name of names) {
    const client = new Client({root: ROOT, account: `accounts/bot-${index}.json`, name, reconnect: false, index});
    client.on('warning', () => {});
    global.Debugger = {info: () => {}, warn: () => {}, error: () => {}};
    try {
      await client.connect();
      const account = Store.read(accountFile(index), {});
      client.close();
      if (account.passToken && (account.hi || account.lo)) {
        log(index, `аккаунт создан: ${account.name || name}`);
        return {ok: true, account};
      }
      last = new Error('сервер не вернул токен аккаунта');
    } catch (error) {
      last = error;
    } finally {
      try {client.close();} catch {}
    }
    log(index, `не удалось зарегистрировать ${JSON.stringify(name)}: ${last.message}`);
  }
  return {ok: false, error: last?.message || 'регистрация не удалась'};
}

async function ensureAccounts(indexes, options) {
  const missing = indexes.filter(index => {
    const account = Store.read(accountFile(index), {});
    return !(account.passToken && (account.hi || account.lo));
  });
  if (!missing.length) return [];
  log('setup', `создаю ${missing.length} аккаунт(ов)`);
  const failures = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < missing.length) {
      const index = missing[cursor++];
      const result = await createAccount(index, options);
      if (!result.ok) failures.push({index, error: result.error});
      await sleep(400);
    }
  };
  await Promise.all(Array.from({length: Math.min(options.concurrency, missing.length)}, worker));
  return failures;
}

class Session {
  constructor(index, options, state) {
    this.index = index;
    this.options = options;
    this.state = state;
    this.kicked = !!state.kicked[index];
    this.joined = false;
    this.joining = false;
    this.stopped = false;
    this.sent = 0;
    this.chatErrors = 0;
    this.joinFailures = 0;
    this.reason = null;
    this.spamTimer = null;
    this.joinTimer = null;
  }

  get client() {return this._client;}

  setPhase(phase, detail = null) {
    this.phase = phase;
    const entry = this.state.stats[this.index] ||= {};
    entry.phase = phase;
    entry.detail = detail;
    entry.sent = this.sent;
    entry.updatedAt = new Date().toISOString();
  }

  async start() {
    if (this.kicked) {
      this.setPhase('kicked-earlier', this.state.kicked[this.index]?.reason || null);
      log(this.index, 'ранее был исключён — вход в комнату не выполняется');
      return;
    }
    const account = Store.read(accountFile(this.index), {});
    if (!account.passToken || (!account.hi && !account.lo)) {
      this.setPhase('no-account');
      log(this.index, 'нет сохранённого аккаунта');
      return;
    }
    this.account = {hi: account.hi, lo: account.lo};
    const client = this._client = new Client({
      root: ROOT, account: `accounts/bot-${this.index}.json`, name: account.name || this.options.name,
      reconnect: true, index: this.index
    });
    client.on('warning', error => this.onWarning(error));
    client.on('state', ({state, error}) => {
      if (this.stopped) return;
      if (state !== 'online') this.setPhase(state, error);
      if (state === 'blocked' && error) log(this.index, `сессия заблокирована: ${error}`);
    });
    client.on('packet', packet => this.onPacket(packet));
    client.on('online', () => this.onOnline());
    try {
      await client.connect();
    } catch (error) {
      this.setPhase('failed', error.message);
      log(this.index, `вход не удался: ${error.message}`);
      if (!client.permanentError) setTimeout(() => this.start().catch(e => log(this.index, e.message)), 5000);
    }
  }

  inRoom() {
    const team = this._client?.team;
    return !!(team && team.code === this.options.code);
  }

  // Only trust a parsed, non-empty member list; a partial decode must not
  // read as a removal, and a missing member entry must not block chat.
  memberMissing() {
    const members = this._client?.team?.members;
    return !!(Array.isArray(members) && members.length && !members.some(member => same(member, this.account)));
  }

  onWarning(error) {
    if (this.stopped) return;
    const message = String(error?.message || error);
    if (message.includes('Разбор')) return;
    if (/24\d{3}/.test(message) === false) log(this.index, `замечание: ${message}`);
  }

  onPacket(packet) {
    if (this.stopped) return;
    if (packet.type === TEAM_CLOSED) {
      if (this.joined) this.markKicked('исключён сервером (24125)');
      else this.setPhase('left-before-join');
      return;
    }
    if (packet.type === TEAM_ERROR) {
      this.setPhase('team-error', packet.payload.toString('hex').slice(0, 32));
      log(this.index, `сервер отклонил команду лобби: ${packet.payload.toString('hex')}`);
      return;
    }
    if (packet.type === TEAM_UPDATE && this.joined && this.memberMissing()) {
      this.markKicked('исключён владельцем (24124 без участника)');
    }
  }

  markKicked(reason) {
    if (this.kicked) return;
    this.kicked = true;
    this.reason = reason;
    this.stopSpam();
    clearTimeout(this.joinTimer);
    this.state.kicked[this.index] = {reason, at: new Date().toISOString()};
    this.setPhase('kicked', reason);
    saveState(this.state);
    log(this.index, `ИСКЛЮЧЁН: ${reason}. Повторный вход отключён`);
    setTimeout(() => {try {this._client?.close();} catch {}}, 500);
  }

  onOnline() {
    if (this.kicked || this.stopped) return;
    this.join().catch(error => log(this.index, `вход в комнату: ${error.message}`));
  }

  async join() {
    if (this.joined || this.joining || this.kicked || this.stopped) return;
    if (this._client.state !== 'online') return;
    if (this._client.team?.code === this.options.code) {
      this.joined = true;
      this.setPhase('in-room');
      this.startSpam();
      return;
    }
    this.joining = true;
    this.setPhase('joining');
    try {
      await Actions.execute(this._client, 'join-room', {code: this.options.code, timeout: 25000});
      if (this._client.team?.code !== this.options.code) throw new Error('сервер не подтвердил лобби');
      this.joined = true;
      this.joinFailures = 0;
      this.setPhase('in-room');
      log(this.index, `в комнате ${this.options.code}`);
      this.startSpam();
    } catch (error) {
      if (this.kicked) return;
      this.joinFailures++;
      this.setPhase('join-failed', error.message);
      log(this.index, `вход не удался (${this.joinFailures}/${this.options.joinRetries}): ${error.message}`);
      if (this.joinFailures < this.options.joinRetries) {
        const delay = Math.min(this.options.joinRetryDelay * this.joinFailures, 120000);
        this.joinTimer = setTimeout(() => {this.join().catch(e => log(this.index, e.message));}, delay);
      } else {
        this.setPhase('join-gave-up', error.message);
      }
    } finally {
      this.joining = false;
    }
  }

  startSpam() {
    if (this.spamTimer || this.kicked || this.stopped) return;
    const tick = async () => {
      if (this.kicked || this.stopped) return;
      if (this._client.state === 'online' && this.inRoom() && !this.memberMissing()) {
        try {
          await Actions.execute(this._client, 'chat', {text: this.options.text, timeout: 8000});
          this.sent++;
          this.setPhase('in-room');
        } catch (error) {
          this.chatErrors++;
          if (!this.kicked) log(this.index, `чат не подтверждён: ${error.message}`);
        }
      } else if (this.joined && this._client.state === 'online') {
        if (this.memberMissing() || !this._client.team) {
          this.markKicked('состояние команды сброшено сервером');
          return;
        }
      }
      const jitter = 0.8 + Math.random() * 0.4;
      this.spamTimer = setTimeout(tick, Math.max(1000, Math.round(this.options.interval * jitter)));
    };
    tick().catch(error => log(this.index, error.message));
  }

  stopSpam() {
    clearTimeout(this.spamTimer);
    this.spamTimer = null;
  }

  stop() {
    this.stopped = true;
    this.stopSpam();
    clearTimeout(this.joinTimer);
    try {this._client?.close();} catch {}
    this.setPhase('stopped');
  }
}

async function main() {
  const {options} = parse(process.argv.slice(2));
  const config = {
    first: Number(options.first ?? 1),
    count: Number(options.count ?? 10),
    name: options.name ?? 'ишак',
    code: String(options.code ?? 'XHPYSUA').toUpperCase(),
    text: options.text ?? 'ишак получил $win',
    interval: Number(options.interval ?? 4000),
    concurrency: Number(options.concurrency ?? 3),
    joinRetries: Number(options.joinRetries ?? 8),
    joinRetryDelay: Number(options.joinRetryDelay ?? 15000)
  };
  if (!Number.isInteger(config.count) || config.count < 1 || config.count > 100) throw new Error('--count: 1–100');
  if (!/^X[A-Z2-9]{1,12}$/.test(config.code)) throw new Error('--code: код комнаты вида XHPYSUA');
  fs.mkdirSync(RUNTIME, {recursive: true});
  fs.mkdirSync(ACCOUNTS, {recursive: true});

  const state = loadState();
  if (options.reset) {
    state.kicked = {};
    saveState(state);
    log('setup', 'список исключённых очищен');
  }

  global.Debugger = {info: () => {}, warn: () => {}, error: () => {}};
  const indexes = Array.from({length: config.count}, (_, n) => config.first + n);
  const failures = await ensureAccounts(indexes, config);
  if (failures.length) log('setup', `не созданы: ${failures.map(f => f.index).join(', ')}`);

  const sessions = indexes.map(index => new Session(index, config, state));
  log('setup', `комната ${config.code}, сообщение ${JSON.stringify(config.text)}, интервал ${config.interval} мс`);

  await Promise.all(sessions.map(session => session.start().catch(error => log(session.index, error.message))));

  const reporter = setInterval(() => {
    const lines = sessions.map(s => `${s.index}:${s.phase || 'init'}${s.sent ? `/${s.sent}` : ''}`);
    console.log(new Date().toISOString(), '[state]', lines.join(' '));
    saveState(state);
  }, 10000);

  const shutdown = () => {
    clearInterval(reporter);
    for (const session of sessions) session.stop();
    saveState(state);
    log('setup', 'остановлено');
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch(error => {console.error(error.message); process.exitCode = 1;});