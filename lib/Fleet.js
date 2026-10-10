const path = require('node:path');
const fs = require('node:fs');
const Client = require('./Client');
const Actions = require('./Actions');
const Store = require('./Store');
const {integer} = require('./Protocol');

class Fleet {
  constructor(root, options = {}, ClientType = Client) {
    this.root = root; this.options = options; this.ClientType = ClientType;
    this.first = integer(options.first ?? 1, 'first', 1, 100000);
    this.count = integer(options.count ?? 1, 'count', 1, 100);
    this.concurrency = integer(options.concurrency ?? 3, 'concurrency', 1, 20);
    this.clients = new Map(); this.inflight = 0; this.stopping = false; this.paused = false;
    this.runtime = path.join(root, '.runtime'); this.commandDir = path.join(this.runtime, 'commands');
    fs.mkdirSync(this.commandDir, {recursive: true}); fs.mkdirSync(path.join(this.runtime, 'results'), {recursive: true});
    this.slots = Array.from({length: this.count}, (_, n) => ({index: this.first + n, status: 'queued', registered: false, joined: false, attempts: 0, error: null}));
    for (const slot of this.slots) {
      let account;
      try {account = Store.read(path.join(root, 'accounts', `bot-${slot.index}.json`), {});}
      catch (error) {slot.status = 'failed'; slot.error = `Повреждён accounts/bot-${slot.index}.json: ${error.message}`; continue;}
      slot.registered = !!(account.passToken && (account.hi || account.lo)); slot.name = account.name || null;
      slot.tag = account.lo ? require('../utils/TagCodec').logicLongToTag(account.hi, account.lo) : null;
    }
  }
  snapshot() {
    const states = {}; for (const slot of this.slots) states[slot.status] = (states[slot.status] || 0) + 1;
    Store.write(path.join(this.root, 'fleet-status.json'), {pid: process.pid, updatedAt: new Date().toISOString(),
      first: this.first, requested: this.count, clubTag: this.options.clubTag || null, states,
      creationPaused: this.paused ? 'Приостановлено командой пользователя' : null, bots: this.slots});
  }
  start() {
    this.snapshot(); this.pump();
    this.timer = setInterval(() => {this.snapshot(); this.processCommands().catch(error => console.error(error.message));}, 1000);
  }
  pump() {
    if (this.stopping || this.paused) return;
    while (this.inflight < this.concurrency) {
      const slot = this.slots.find(s => s.status === 'queued' && s.registered) || this.slots.find(s => s.status === 'queued');
      if (!slot) break;
      this.launch(slot);
    }
  }
  async launch(slot) {
    this.inflight++; slot.status = 'connecting';
    let initial = true, client, connectDeadline;
    try {
      client = new this.ClientType({root: this.root, account: `accounts/bot-${slot.index}.json`, index: slot.index,
        name: slot.name || `${this.options.namePrefix ?? 'Bot'}${slot.index}`, reconnect: true, proxyFile: this.options.proxyFile,
        proxyPoolFile: this.options.proxyPoolFile, dump: this.options.dump, battleTransport:this.options.battleTransport});
      this.clients.set(slot.index, client);
      client.peers = this.clients;
      client.on('state', ({state, error}) => {if (this.clients.get(slot.index) !== client) return; slot.status = state; slot.error = error; slot.attempts = client.attempts || 0; this.snapshot();});
      client.on('warning', error => {if (this.clients.get(slot.index) !== client) return; slot.error = error.message; console.error(`bot=${slot.index} ${error.message}`);});
      client.on('account', account => {
        if (this.clients.get(slot.index) !== client) return;
        slot.registered = !!(account.passToken && (account.hi || account.lo)); slot.name = account.name || null;
        slot.tag = account.lo ? require('../utils/TagCodec').logicLongToTag(account.hi, account.lo) : null;
        if (this.options.clubTag) slot.joined = Actions.same(account.club, require('./Protocol').target(this.options.clubTag));
      });
      client.on('packet', () => {slot.lastServerAt = client.lastServerAt; slot.matchmaking = client.matchmaking || null;});
      connectDeadline = setTimeout(() => {if (initial) {client.close(); slot.status = 'failed'; slot.error = 'Вход/ник не подтверждены за 90 секунд';}}, 90000);
      const join = async () => {
        slot.onlineSince = client.onlineSince; slot.joined = false;
        if (!this.options.clubTag) return;
        slot.status = 'joining-club';
        try {
          const target = require('./Protocol').target(this.options.clubTag);
          if (!Actions.same(client.club, target)) await Actions.execute(client, 'join-club', {clubTag: this.options.clubTag});
          slot.joined = Actions.same(client.club, target); slot.clubError = null;
        } catch (error) {slot.clubError = error.message; console.error(`bot=${slot.index} ${error.message}`);}
        slot.status = client.state; this.snapshot();
      };
      client.on('online', () => {if (this.clients.get(slot.index) !== client || this.stopping) return; if (!initial) join().catch(error => console.error(error.message));});
      await client.connect(); initial = false; clearTimeout(connectDeadline); await join();
    } catch (error) {
      initial = false; clearTimeout(connectDeadline); slot.error = error.message; const blocked = !!client?.permanentError;
      client?.close(); slot.status = blocked ? 'blocked' : 'failed';
    } finally {this.inflight--; this.snapshot(); this.pump();}
  }
  async processCommands() {
    if (this.processing || this.stopping) return;
    this.processing = true;
    try {
      for (const name of fs.readdirSync(this.commandDir).filter(n => /^[a-f0-9-]+\.json$/.test(n))) {
        const file = path.join(this.commandDir, name), item = Store.read(file);
        const resultFile = path.join(this.runtime, 'results', name);
        try {
          let result;
          if (item.action === 'pause') {this.paused = true; result = {paused: true};}
          else if (item.action === 'resume') {this.paused = false; this.pump(); result = {paused: false};}
          else if (item.action === 'retry') {
            for (const slot of this.slots.filter(s => ['failed', 'blocked'].includes(s.status))) {this.clients.get(slot.index)?.close(); slot.status = 'queued'; slot.error = null;}
            this.paused = false; this.pump(); result = {retried: true};
          } else {
            const indexes = item.all ? this.slots.map(s => s.index) : [integer(item.bot, 'bot', this.first, this.first + this.count - 1)];
            result = [];
            for (const index of indexes) {
              const client = this.clients.get(index);
              if (!client || client.state !== 'online') {result.push({index, error: 'Бот ещё не вошёл'}); continue;}
              try {result.push({index, ...await Actions.execute(client, item.action, item.args)});}
              catch (error) {result.push({index, error: error.message});}
            }
          }
          Store.write(resultFile, {ok: true, result});
        } catch (error) {Store.write(resultFile, {ok: false, error: error.message});}
        fs.unlinkSync(file);
      }
    } finally {this.processing = false;}
  }
  stop() {
    this.stopping = true; clearInterval(this.timer);
    for (const client of this.clients.values()) client.close();
    for (const slot of this.slots) slot.status = 'stopped'; this.snapshot();
  }
}
module.exports = Fleet;
