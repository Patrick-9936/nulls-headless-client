const path = require('node:path'), fs = require('node:fs');
const Client = require('./Client'), Actions = require('./Actions'), Store = require('./Store');
const {currentEvent, Cycle} = require('./CandidateLoop');
const MatchmakingGate = require('./MatchmakingGate');
const regionCatalog = require('../data/regions.json');

class Runner {
  constructor(root, options = {}, ClientClass = Client) {
    this.ClientClass = ClientClass;
    this.root = root; this.options = options; this.bots = []; this.inflight = 0; this.stopping = false;
    this.matchmakingGate = new MatchmakingGate(Number(options.maxQueued ?? 1));
    this.initial = Number(options.initial ?? 10); this.max = options.max !== undefined && Number(options.max) === 0 ? null : Number(options.max ?? 500);
    this.concurrency = Number(options.concurrency ?? 8); this.growSeconds = Number(options.growSeconds ?? 1);
    this.growBy = Number(options.growBy ?? 2);
    if (options.name !== undefined && (typeof options.name !== 'string' || !options.name.trim() || Buffer.byteLength(options.name) > 30 || /[\x00-\x1f]/.test(options.name))) throw new Error('Некорректный ник нового аккаунта');
    this.rssLimit = Number(options.rssMb ?? 160) * 1024 * 1024;
    this.regions = options.regions ? String(options.regions).split(',').map(code => code.trim().toUpperCase()) : [];
    if (this.regions.some(code => !regionCatalog.some(region => region.Name === code))) throw new Error('Неизвестный регион аккаунта');
    if (![this.initial, this.concurrency, this.growSeconds, this.growBy].every(Number.isInteger)
      || this.initial < 1 || (this.max !== null && (!Number.isSafeInteger(this.max) || this.max < this.initial)) || this.concurrency < 1 || this.concurrency > 8
      || this.growSeconds < 1 || this.growBy < 1 || this.growBy > 2 || !Number.isFinite(this.rssLimit) || this.rssLimit < 64 * 1024 * 1024) throw new Error('Некорректные лимиты кандидатов');
    this.files = options.manifest ? Store.read(path.resolve(root, options.manifest)) : [];
    if (!Array.isArray(this.files) || this.files.some(file => typeof file !== 'string')) throw new Error('manifest: нужен массив путей к аккаунтам');
    this.target = this.initial; this.nextGrowth = Date.now() + this.growSeconds * 1000; this.startedAt = new Date().toISOString();
  }
  async play(bot) {
    const c = bot.client;
    if (this.stopping || bot.busy || c.state !== 'online' || bot.cycle.phase !== 'idle') return;
    if (!this.matchmakingGate.acquire(bot)) return;
    bot.busy = true; const completedBefore = bot.cycle.completed;
    try {
      if (this.regions.length && !bot.regionApplied) {
        const country = this.regions.includes(c.account.botRegion?.country) ? c.account.botRegion.country
          : this.regions[require('node:crypto').randomInt(this.regions.length)];
        const region = await Actions.execute(c, 'account-region', {region: country, timeout: 10000});
        c.account.botRegion = {country, reference: region.region, confirmedAt: new Date().toISOString()}; c.save();
        bot.regionApplied = true;
      }
      const selected = currentEvent(c.home); bot.event = selected.event;
      if (!c.team && c.account?.team) {
        const waiting = c.wait([24124], () => !!c.team, [], 3000);
        await waiting.promise.catch(() => {});
      }
      if (c.team && (c.team.type !== 0 || c.team.members?.length > 1)) await Actions.execute(c, 'leave-room', {timeout: 10000});
      try {if (!c.team) await Actions.execute(c, 'create-room', {type: 0, timeout: 10000});}
      catch (error) {
        // Login may return Home before the saved lobby snapshot. The server's code 10 proves membership.
        if (!/команда 10:/.test(error.message)) throw error;
        await Actions.execute(c, 'leave-room', {timeout: 10000});
        await Actions.execute(c, 'create-room', {type: 0, timeout: 10000});
      }
      await Actions.execute(c, 'team-event', {...selected, modifier: 0, timeout: 10000});
      if(bot.cycle.phase!=='idle')return;
      if(c.team?.members?.some(m=>m.hi===c.account.hi&&m.lo===c.account.lo&&m.ready))await Actions.execute(c,'unready',{timeout:10000});
      if (!bot.cycle.begin(c.generation)) return;
      bot.matchStartedAt = Date.now();
      const result = await Actions.execute(c, 'matchmake', {timeout: 30000});
      bot.lastResponse = result.response; bot.error = null;
    } catch (error) {
      // BattleEnd may close a pending action as part of reconnecting. It must not overwrite the confirmed result.
      if (bot.cycle.completed === completedBefore) {
        bot.error = error.message; bot.retryAt = Date.now() + 5000;
        if (bot.cycle.phase === 'idle') bot.cycle.phase = 'idle';
        else if (!['result-unknown', 'awaiting-resume', 'loading', 'battle','queued'].includes(bot.cycle.phase)) bot.cycle.phase = 'action-failed';
      }
    }
    finally {
      // Preparation failures precede Ready. Unknown outcomes after Ready keep the reservation.
      if (bot.cycle.phase === 'idle') this.matchmakingGate.release(bot);
      bot.busy = false; this.snapshot();
    }
  }
  launch(index) {
    const file = this.files[index - 1] || `.runtime/candidates/accounts/bot-${index}.json`;
    const account = Store.read(path.resolve(this.root, file), {});
    const client = new this.ClientClass({root: this.root, account: file, name: account.name ? undefined : this.options.name ?? `${this.options.prefix || 'EndyCs'}${index}`,
      index, reconnect: true, proxyPoolFile: this.options.proxyPool ? path.resolve(this.root, this.options.proxyPool) : undefined,
      battleTransport: this.options.battleTransport,
      onProxyPoolEmpty: () => this.refreshPool()});
    const bot = {index, client, cycle: new Cycle(), error: null, busy: false}; this.bots.push(bot); this.inflight++;
    client.on('state', ({state}) => {if (state === 'setting-profile') bot.cycle.resume(client.generation);});
    client.on('online', () => {setImmediate(() => {if (bot.cycle.phase === 'idle') this.play(bot);});});
    client.on('disconnected', () => bot.cycle.disconnect());
    client.on('battle-vision',()=>{bot.cycle.battleConnected(client.generation);if(bot.cycle.phase==='battle')this.matchmakingGate.release(bot);this.snapshot();});
    client.on('warning', error => {bot.error = error.message; if (/proxy|SOCKS5|Нет ответа сервера|timed out/i.test(error.message)) this.refreshPool();});
    client.on('packet', packet => {
      const ended = bot.cycle.packet(packet.type, client.generation, packet.payload.length);
      if (bot.cycle.phase === 'queued') this.matchmakingGate.occupy(bot);
      if (['loading', 'battle', 'ended'].includes(bot.cycle.phase) ||
          packet.type === 20406 && bot.cycle.phase === 'idle' && bot.cycle.generation === client.generation) this.matchmakingGate.release(bot);
      if ([20405, 20406, 20559, 24112, 23456].includes(packet.type)) this.snapshot();
      if (!ended) return;
      // Re-enter Home only after a server result, then select the current rotating event again.
      bot.cycle.resetAfterEnd();
      client.reconnect().catch(error => {bot.error = error.message;});
    });
    client.connect().catch(error => {bot.error = error.message;}).finally(() => {this.inflight--;});
  }
  tick() {
    if (this.stopping) return;
    const rss = process.memoryUsage().rss;
    if (rss > this.rssLimit) {this.stopReason = 'rss-limit'; this.stop(); return;}
    // Do not create new accounts while existing ones have registration/authentication errors.
    const blocked = this.bots.some(bot => bot.client.permanentError);
    this.growthPaused = blocked ? 'server-or-action-error' : rss > this.rssLimit * 0.8 ? 'memory-budget' : null;
    if (!this.growthPaused && this.bots.length >= this.initial && Date.now() >= this.nextGrowth && (this.max === null || this.target < this.max)) {
      this.target += this.max === null ? this.growBy : Math.min(this.growBy, this.max - this.target); this.nextGrowth = Date.now() + this.growSeconds * 1000;
    }
    if (!this.growthPaused && this.bots.length < this.target && this.inflight < this.concurrency && Date.now() >= (this.nextLaunch || 0)) {
      const count = Math.min(this.growBy, this.target - this.bots.length, this.concurrency - this.inflight);
      for (let i = 0; i < count; i++) this.launch(this.bots.length + 1);
      this.nextLaunch = Date.now() + this.growSeconds * 1000;
    }
    for (const bot of this.bots) if (['loading','battle'].includes(bot.cycle.phase) && Date.now() - bot.matchStartedAt > 10 * 60 * 1000) {
      bot.cycle.phase = 'result-unconfirmed'; bot.error = '10 минут без BattleEndMessage; новый подбор не запускается';
    }
    this.matchmakingGate.waiting = this.matchmakingGate.waiting.filter(bot => bot.cycle.phase === 'idle' && bot.client.state === 'online' && Date.now() >= (bot.retryAt || 0));
    for (const bot of this.bots) if (bot.cycle.phase === 'idle' && !bot.busy && bot.client.state === 'online' && Date.now() >= (bot.retryAt || 0)) this.play(bot);
    this.snapshot();
  }
  refreshPool() {
    if (this.stopping || Date.now() < (this.nextProxyRefresh || 0)) return;
    this.nextProxyRefresh = Date.now() + 30000;
    try {const pid = Number(fs.readFileSync(path.join(this.root, 'proxy-watch.pid'), 'utf8'));
      if (Number.isInteger(pid) && pid > 1 && fs.readFileSync(`/proc/${pid}/cmdline`).includes(Buffer.from('tools/proxy-watch.js'))) process.kill(pid, 'SIGUSR2');
    } catch {}
  }
  snapshot() {
    Store.write(path.join(this.root, '.runtime/candidates/status.json'), {
      pid: process.pid, running: !this.stopping, startedAt: this.startedAt, updatedAt: new Date().toISOString(),
      max: this.max, target: this.target, rssBytes: process.memoryUsage().rss, stopReason: this.stopReason || null, growthPaused: this.growthPaused || null, growBy: this.growBy, growSeconds: this.growSeconds,
      matchmakingLimit: this.matchmakingGate.limit, matchmakingReserved: this.matchmakingGate.active.size, matchmakingWaiting: this.matchmakingGate.waiting.map(bot => bot.index),
      battleControl: this.options.battleTransport==='udp'?'UDP vision updates and neutral inputs; movement and combat control are not implemented':'TCP lobby/matchmaking only; UDP is disabled',
      bots: this.bots.map(bot => ({index: bot.index, state: bot.client.state, phase: bot.cycle.phase,
        tag: Actions.publicAccount(bot.client).tag, name: bot.client.account.name || null, event: bot.event || null,
        completed: bot.cycle.completed, udp: bot.client.battleSession?.status()||null, region: bot.client.account.botRegion?.country || null,
        matchmaking: bot.client.matchmaking || null, waitingForMatchmaking: this.matchmakingGate.waiting.includes(bot),
        regionConfirmed: !!bot.regionApplied, lastServerAt: bot.client.lastServerAt || null, error: bot.error}))});
  }
  start() {this.tick(); if (!this.stopping) this.timer = setInterval(() => this.tick(), 1000);}
  stop() {if (this.stopping) return; this.stopping = true; clearInterval(this.timer); for (const bot of this.bots) bot.client.close(); this.snapshot(); this.onStop?.();}
}
module.exports = Runner;
