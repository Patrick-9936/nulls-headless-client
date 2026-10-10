const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const {EventEmitter} = require('node:events');
const Messaging = require('../Messaging/Messaging');
const Queue = require('../DataStream/Queue');
const Proxy = require('../utils/ProxyConnect');
const Store = require('./Store');
const Decode = require('./Decode');
const Protocol = require('./Protocol');

class Client extends EventEmitter {
  constructor(options = {}) {
    super();
    this.root = path.resolve(options.root || path.join(__dirname, '..'));
    this.file = path.resolve(this.root, options.account || 'account.json');
    this.config = {...Store.read(path.join(this.root, 'config.json')), ...options.config};
    if (this.config.cryptoMode !== 'nulls-native19') throw new Error('Этот клиент поддерживает Nulls Native19');
    require('../utils/NullsLicense').apply(this.config, this.root);
    this.account = Store.read(this.file, {hi: 0, lo: 0});
    if (options.age !== undefined) throw new Error('Nulls v69 не сообщает подтверждаемое состояние возраста; --age здесь не поддерживается');
    this.options = options; this.state = 'stopped'; this.closed = false; this.pending = new Set();
    if(options.battleTransport!==undefined&&!['none','udp'].includes(options.battleTransport))throw Error('battle-transport: none|udp');
    this.generation = 0; this.failures = 0; this.club = null; this.team = null;
    global.Debugger ||= Object.fromEntries(['info', 'warn', 'error'].map(k => [k, (...args) => console[k === 'info' ? 'log' : k](...args)]));
  }
  save() {Store.write(this.file, this.account); this.emit('account', this.account);}
  status(state, error = null) {this.state = state; this.lastError = error; this.emit('state', {state, error});}
  connect() {
    if (this.state === 'online') return Promise.resolve(this);
    if (this.openPromise) return this.openPromise;
    this.closed = false;
    this.lock ||= new (require('./AccountLock'))(this.file);
    if (!this.lock.owned) this.lock.acquire();
    this.openPromise = new Promise((resolve, reject) => {this.resolveOpen = resolve; this.rejectOpen = reject;});
    this._open();
    return this.openPromise;
  }
  _open() {
    try {this._startOpen();}
    catch (error) {this.status('failed', error.message); this.rejectOpen?.(error); this.openPromise = null; this.socket?.destroy(); this.lock?.release();}
  }
  _startOpen() {
    if (this.closed) return;
    this.team = null; this.club = null; this.recommendedClubs = null; this.leaderboard = null; this.invitations = []; this.friendPresence = new Map(); this.clubStream = []; this.clubStreamError = null; this.clubStreamReady = false;

    const generation = ++this.generation;
    this.status('connecting'); this.attempts = (this.attempts || 0) + 1;
    this.account = Store.read(this.file, this.account);
    this.account.deviceId ||= crypto.randomUUID();
    for (const key of ['openDeviceId', 'androidId', 'idForVendor']) this.account[key] ||= this.account.deviceId;
    this.save();
    this.socket = new net.Socket(); this.socket.setTimeout(this.options.idleTimeout || 30000);
    const socket = this.socket; const queue = new Queue();
    const action = {mode: 'login', name: this.options.name, once: false};
    const messaging = new Messaging(socket, queue, {config: this.config, account: this.account, action,
      root: this.root, accountPath: this.file, dump: !!this.options.dump, reconnect: () => this._schedule(250)});
    this.messaging = messaging; messaging.saveAccount = () => this.save();
    messaging.onProfileError = error => {
      this.permanentError=error.message;this.status('blocked',error.message);
      this.rejectOpen?.(error);this.resolveOpen=this.rejectOpen=null;this.openPromise=null;
    };
    messaging.saveConfig = () => Store.write(path.join(this.root, 'config.json'), this.config);
    messaging.onPacket = (id, payload) => this._packet(id, payload);
    const loggedIn = messaging.onLoggedIn.bind(messaging);
    messaging.onLoggedIn = () => {
      if (!this.account.passToken || (!this.account.hi && !this.account.lo)) throw new Error('LoginOk не содержит действительных данных аккаунта');
      this.status('setting-profile'); loggedIn(); clearTimeout(messaging.actionTimeout);
    };
    const homeReady = messaging.onHomeReady.bind(messaging);
    messaging.onHomeReady = payload => {
      homeReady(payload); this.home = Buffer.from(payload);
      if (messaging.namePending || (this.options.name && this.account.name !== this.options.name)) return;
      const wasOnline = this.state === 'online';
      clearTimeout(this.deadline); this.failures = 0; this.onlineSince = new Date().toISOString();
      this.status('online'); this.resolveOpen?.(this); this.resolveOpen = this.rejectOpen = null; this.openPromise = null;
      if (!wasOnline) this.emit('online');
    };
    clearTimeout(this.deadline);
    this.deadline = setTimeout(() => socket.destroy(new Error(`Не подтверждён этап ${this.state} за 60 секунд`)), this.options.connectTimeout || 60000);
    let tunnelReady = false;
    socket.on('data', bytes => {
      if (generation !== this.generation || !tunnelReady) return;
      this.lastServerAt = new Date().toISOString(); queue.add(bytes);
      if (queue.size() > 16 * 1024 * 1024) return socket.destroy(new Error('Переполнена очередь пакетов'));
      try {while (generation===this.generation&&messaging.pendingJob()) messaging.update();}
      catch (error) {socket.destroy(error);}
    });
    socket.on('timeout', () => socket.destroy(new Error('Нет ответа сервера 30 секунд')));
    socket.on('error', error => {this.lastError = error.message; this.emit('warning', error);});
    socket.on('close', () => {
      if (generation !== this.generation) return;
      this.battleAttempt=(this.battleAttempt||0)+1;
      clearTimeout(this.battleRetryTimer);
      this.battleSession?.close();
      clearTimeout(this.deadline); this.emit('disconnected');
      for (const item of [...this.pending]) item.reject(new Error('Соединение прервано; результат действия неизвестен'));
      if (this.closed || this.permanentError) {this.lock?.release(); return;}
      const profileReconnect = messaging.closing && ['nickname changed', 'verify age'].includes(messaging.closeReason);
      if (this.options.reconnect || this.reconnectTimer || profileReconnect) this._schedule(1000 * 2 ** Math.min(this.failures++, 5));
      else {this.lock?.release(); this.status('failed', this.lastError || 'Соединение закрыто'); this.rejectOpen?.(new Error(this.lastError || 'Соединение закрыто')); this.openPromise = null;}
    });
    let proxy;
    try {
      proxy = Proxy.loadProxy(this.options.proxyFile);
      if (!proxy && this.options.proxyPoolFile) {
        let pool;
        try {pool = Proxy.loadPool(this.options.proxyPoolFile);} catch (error) {if (error.code !== 'ENOENT') throw error; pool = [];}
        if (!pool.length) {this.options.onProxyPoolEmpty?.(); throw new Error('Нет проверенных прокси');}
        proxy = pool[(this.attempts - 1 + (this.options.index || 0)) % pool.length];
      }
    } catch (error) {socket.destroy(error); return;}
    this.currentProxy=proxy;
    Proxy.connectSocket(socket, {host: this.config.host, port: this.config.port, proxy}, () => {
      if (generation !== this.generation || this.closed) return;
      tunnelReady = true; this.status('authenticating'); messaging.sendPepperAuthentication();
    });
  }
  _schedule(delay) {
    if (this.closed || this.permanentError || this.reconnectTimer) return;
    this.status('reconnecting', this.lastError);
    this.reconnectTimer = setTimeout(() => {this.reconnectTimer = null; this._open();}, delay);
  }
  _packet(type, payload) {
    if (type === this.config.packetIds.loginFailed) {
      const code = payload.length >= 4 ? payload.readInt32BE(0) : null;
      this.permanentError = `Сервер отклонил вход: ${code}`; this.status('blocked', this.permanentError);
      this.rejectOpen?.(new Error(this.permanentError)); this.openPromise = null;
    }
    try {
      if (type === 24700) this.tvChannels = require('./BrawlTV').channels(payload);
      if (type === 24701) this.tvNext = require('./BrawlTV').nextUp(payload);
      if (type === 20405) this.matchmaking = {...Decode.matchmaking(payload), updatedAt: new Date().toISOString()};
      if ([20406, 20559, 24112, 23456].includes(type)) this.matchmaking = null;
      if (type === 24106) {
        const s = new (require('../DataStream/ByteStream'))(); s.writeVInt(0); s.writeVInt(0); s.writeVInt(0);
        this.messaging.send(14105, s.getBytes(), 9);
      }
      if ([20559, 24112].includes(type)) this.battle = {packet: type, at: new Date().toISOString()};
      if (type===24112 && this.options.battleTransport==='udp') {
        const connection=require('./BattleProtocol').connection(payload);
        this._openBattle(connection).catch(e=>this.emit('warning',e));
      }
      if (type===23456) {this.battleAttempt=(this.battleAttempt||0)+1;clearTimeout(this.battleRetryTimer);this.battleSession?.close();}
      if (type === 24399) {const result = Decode.club(type, payload); this.club = result.club; this.role = result.role; this.account.club = result.club; this.save();}
      if (type === 24178) {const s = Decode.stream(payload); this.regionResult = {code: s.readVInt(), region: Protocol.readReference(s)};}
      if (type === 24301) this.clubInfo = Decode.club(type, payload);
      if (type === 24304) this.recommendedClubs = Decode.recommendedClubs(payload);
      if (type === 24124) {this.team = Decode.team(payload); this.account.team = this.team; this.save();}
      if (type === 24125) {this.team = null; this.account.team = null; this.save();}
      if ([24311, 24312].includes(type)) {
        try {
          const decoded = require('./ClubStream').decode(type, payload);
          this.clubStreamError = null;
          if (type === 24311) {this.clubStream = decoded.entries; this.clubStreamReady = true;}
          else for (const entry of decoded.entries) {this.clubStream = (this.clubStream || []).filter(old => old.entryId.hi !== entry.entryId.hi || old.entryId.lo !== entry.entryId.lo); this.clubStream.push(entry);}
        } catch (error) {this.clubStreamError = error.message; throw error;}
      }
      if (type === 24333) {const s = Decode.stream(payload); this.clubResponse = {code: s.readVInt(), detail: s.readVInt(), at: Date.now()};}
      if (type === 24555) {
        const presence = Decode.friendPresence(payload); this.friendPresence ||= new Map();
        this.friendPresence.set(presence.tag, presence);
        for (const friend of this.friends || []) if (friend.tag === presence.tag) Object.assign(friend, {online: presence.online, status: presence.status ?? 0});
      }
      if (type === 24403) this.leaderboard = Decode.leaderboard(payload);
      if ([24589, 24582].includes(type)) {this.invitations ||= []; this.invitations.push(Decode.invitation(type, payload)); if (this.invitations.length > 50) this.invitations.shift();}
      if (type === 20207) this.clubOnline = Decode.clubOnline(payload);
      if (type === 20105) {this.friends = Decode.friends(payload).friends.map(friend => ({...friend, ...(this.friendPresence?.get(friend.tag) || {})})); this.friendParseError = null;}
      if (type === 20106) {
        const update = Decode.friendUpdate(payload); this.friends ||= [];
        this.friends = this.friends.filter(friend => friend.hi !== update.friend.hi || friend.lo !== update.friend.lo);
        if (update.added && update.friend.relationship !== 0) this.friends.push(update.friend);
      }
    } catch (error) {this.emit('warning', new Error(`Разбор ${type}: ${error.message}`));}
    const packet = {type, payload, at: new Date().toISOString()};
    this.emit('packet', packet);
    for (const item of [...this.pending]) {
      try {
        if (item.errors.includes(type)) {
          let detail = `пакет ${type}, данные ${payload.toString('hex').slice(0, 32)}`;
          if (type === 24129) {
            const s = Decode.stream(payload); s.readVInt(); const code = s.readVInt();
            detail = `команда ${code}: ${require('../data/team-errors.json')[code] || 'Неизвестная ошибка команды'}`;
          }
          item.reject(new Error(`Сервер отклонил действие: ${detail}`));
        }
        else if (item.types.includes(type) && item.check(packet)) item.resolve(packet);
      } catch (error) {item.reject(error);}
    }
  }
  wait(types, check = () => true, errors = [], timeout = 20000) {
    let item;
    const promise = new Promise((resolve, reject) => {
      const done = fn => value => {clearTimeout(item.timer); this.pending.delete(item); fn(value);};
      item = {types, errors, check, started: Date.now()}; item.resolve = done(resolve); item.reject = done(reject);
      item.timer = setTimeout(() => {const response = this.clubResponse?.at >= item.started ? `; ответ клуба ${this.clubResponse.code}` : ''; item.reject(new Error(`Нет подтверждения сервера за ${timeout / 1000} секунд (ожидались ${types.join(', ')})${response}`));}, timeout);
      this.pending.add(item);
    });
    promise.catch(() => {});
    return {promise, cancel: error => item.reject(error)};
  }
  async request(command, args = {}, options = {}) {
    if (this.state !== 'online') throw new Error(`Бот не готов: ${this.state}`);
    const message = Protocol.encode(command, args);
    const waiter = this.wait(options.types || [], options.check, options.errors || [], options.timeout || 20000);
    this.messaging.send(message.id, message.payload, message.version);
    const packet = await waiter.promise;
    return {command, confirmed: true, response: packet.type};
  }
  async reconnect() {
    this.close(); this.permanentError = null; this.lastError = null;
    await this.connect(); return this;
  }
  async _openBattle(connection) {
    clearTimeout(this.battleRetryTimer);
    this.battleSession?.close();const generation=this.generation;
    const attempt=this.battleAttempt=(this.battleAttempt||0)+1;
    const cacheFile=path.join(this.root,'.runtime/udp-proxies.json');
    const cached=Store.read(cacheFile,{proxies:[]});
    this.udpUnsupported||=new Map();const proxies=[];
    const add=proxy=>{if(proxy&&Date.now()<(this.udpUnsupported.get(proxy.host+':'+proxy.port)||0))return;
      if(!proxies.some(p=>p===proxy||(p&&proxy&&p.host===proxy.host&&p.port===proxy.port)))proxies.push(proxy);};
    if(this.udpProxy)add(this.udpProxy);
    for(const entry of cached.proxies||[]) {try{const proxy=Proxy.parseProxy(entry);if(proxy.type==='socks5')add(proxy);}catch{}}
    add(this.currentProxy);
    if(this.options.proxyPoolFile)for(const proxy of Proxy.loadPool(this.options.proxyPoolFile)) {
      if(proxy.type==='socks5')add(proxy);
    }
    for(const proxy of proxies.slice(0,8)) {
      if(this.closed||generation!==this.generation||attempt!==this.battleAttempt)return;
      const session=this.battleSession=new (require('./BattleSession'))(connection,{proxy});
      session.on('packet',p=>{if(this.battleSession===session)this.emit('battle-packet',p);});
      session.on('vision',v=>{if(this.battleSession===session)this.emit('battle-vision',v);});
      const established=await new Promise(resolve=>{
        session.once('vision',()=>resolve(true));session.once('warning',()=>resolve(false));session.once('close',()=>resolve(false));
        session.start();
      });
      if(established){this.udpProxy=proxy;
        if(proxy){const url=`socks5://${proxy.host.includes(':')?'['+proxy.host+']':proxy.host}:${proxy.port}`;
          const current=Store.read(cacheFile,{proxies:[]});
          Store.write(cacheFile,{proxies:[{url,username:proxy.username,password:proxy.password,confirmedAt:new Date().toISOString()},...(current.proxies||[]).filter(p=>p.url!==url)].slice(0,32)});
        }
        session.on('warning',e=>{
        this.emit('warning',e);
        if(!this.closed&&generation===this.generation&&attempt===this.battleAttempt)this.battleRetryTimer=setTimeout(()=>this._openBattle(connection).catch(error=>this.emit('warning',error)),1000);
      });return;}
      session.close();
      if(proxy)this.udpUnsupported.set(proxy.host+':'+proxy.port,Date.now()+(/rejected:\s*7$/.test(session.error||'')?120000:30000));
      if(proxy){if(this.udpProxy?.host===proxy.host&&this.udpProxy?.port===proxy.port)this.udpProxy=null;
        const current=Store.read(cacheFile,{proxies:[]});Store.write(cacheFile,{proxies:(current.proxies||[]).filter(entry=>{try{const p=Proxy.parseProxy(entry);return p.host!==proxy.host||p.port!==proxy.port;}catch{return false;}})});
      }
    }
    if(!this.closed&&generation===this.generation&&attempt===this.battleAttempt){this.emit('warning',new Error('Не подтверждён UDP-канал боя через доступные прокси'));
      this.battleRetryTimer=setTimeout(()=>this._openBattle(connection).catch(e=>this.emit('warning',e)),proxies.length?1000:15000);
    }
  }
  close() {
    clearTimeout(this.battleRetryTimer);
    this.battleAttempt=(this.battleAttempt||0)+1;
    this.battleSession?.close();
    this.closed = true; clearTimeout(this.reconnectTimer); this.reconnectTimer = null; clearTimeout(this.deadline);
    for (const item of [...this.pending]) item.reject(new Error('Клиент остановлен'));
    this.messaging?.close('client stopped'); this.socket?.destroy(); this.status('stopped');
    this.rejectOpen?.(new Error('Клиент остановлен')); this.openPromise = null; this.lock?.release();
  }
}
module.exports = Client;
