#!/usr/bin/env node
'use strict';
// Bulk pipeline: verified proxy pool -> guest registration -> club raid.
// The raid keeps a rotation of open clubs refreshed every few seconds, so bots
// spread across the whole list instead of camping one club, and leave quickly.
const fs = require('node:fs');
const path = require('node:path');

const {parse} = require('../lib/Args');
const BaseClient = require('../lib/Client');
const Actions = require('../lib/Actions');
const Protocol = require('../lib/Protocol');
const Store = require('../lib/Store');
const Sources = require('../lib/ProxySources');
const Sync = require('../lib/ProxySync');
const {parseProxy} = require('../utils/ProxyConnect');

const ROOT = path.resolve(__dirname, '..');
const RUNTIME = path.join(ROOT, '.runtime');
const ACCOUNTS = path.join(ROOT, 'accounts');
const POOL_FILE = path.join(ROOT, 'working-proxies.json');
const STATE_FILE = path.join(RUNTIME, 'club-rush.json');
const CONFIG = {...Store.read(path.join(ROOT, 'config.json')), clientLicensePath: 'client-license.bin'};

// --- graceful stop --------------------------------------------------------
// A stop from the panel must not just drop sockets: every bot leaves its club
// first, so the target is not left holding 30 idle bodies.
const stopping = {value: false};
const live = new Set();

class Client extends BaseClient {
  constructor(options) {
    super(options);
    live.add(this);
    this.on('close', () => live.delete(this));
  }
}

async function gracefulLeave() {
  stopping.value = true;
  const members = [...live].filter(client => client.club && client.state === 'online');
  await Promise.all(members.map(client =>
    Actions.execute(client, 'leave-club', {timeout: 8000}).catch(() => {})));
  for (const client of [...live]) {try {client.close();} catch {}}
}

let leaving = false;
function onSignal(signal) {
  if (leaving) {flushStatsFinal(); process.exit(1);}
  leaving = true;
  log('shutdown', `${signal}: выхожу из клубов`);
  // Восемь секунд — потолок для панели: финальный файл пишется даже если
  // leave-club не успел ответить, иначе бот видит пустую статистику.
  const hard = setTimeout(() => {flushStatsFinal(); process.exit(0);}, 8000);
  gracefulLeave().catch(() => {}).finally(async () => {
    clearTimeout(hard);
    // Короткая пауза, чтобы воркеры успели обнулить online/active после
    // закрытия сокетов: финальный файл должен показывать реальный ноль.
    await sleep(500);
    flushStatsFinal();
    process.exit(0);
  });
}
process.on('SIGTERM', () => onSignal('SIGTERM'));
process.on('SIGINT', () => onSignal('SIGINT'));
process.on('beforeExit', () => flushStatsFinal());

const accountPath = index => path.join(ACCOUNTS, `bot-${index}.json`);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const log = (scope, ...args) => console.log(new Date().toISOString(), `[${scope}]`, ...args);

// Буквы O в тегах не бывает — только ноль; регистр не важен.
const clubTagOf = value => '#' + String(value || '').trim().replace(/^[#＃]/, '').replace(/[OoОо]/g, '0').toUpperCase();


// --- live stats -----------------------------------------------------------
// Панель читает числа из файла, а не разбирает stdout: на коротком прогоне
// пятнадцатисекундный reporter не успевал напечатать ни одной строки, и бот
// показывал нули. Файл переписывается атомарно (tmp + rename), поэтому
// читатель никогда не видит половину тела.
const statsTargets = new Map(); // kind -> {totals, extra}
let statsPath = null;
const statsStartedAt = Date.now();

function publishStats(kind, totals, extra) {
  // extra может быть функцией: счётчики вроде raid.active меняются на ходу.
  const resolved = typeof extra === 'function' ? extra() : extra;
  statsTargets.set(kind, {totals: totals || {}, extra});
  if (!statsPath) return;
  const payload = {kind, ts: Date.now(), elapsed: Math.round((Date.now() - statsStartedAt) / 1000)};
  for (const [key, value] of Object.entries(totals || {})) if (typeof value === 'number') payload[key] = value;
  if (resolved) for (const [key, value] of Object.entries(resolved)) if (value !== undefined) payload[key] = value;
  const body = JSON.stringify(payload);
  const tmp = statsPath + '.tmp';
  try {fs.writeFileSync(tmp, body); fs.renameSync(tmp, statsPath);} catch {}
}

// Финальная запись идёт через тот же писатель, чтобы формат не разъезжался:
// вызывается из finally каждого режима и из обработчиков выхода.
function flushStatsFinal() {
  for (const [kind, entry] of statsTargets) {
    const base = typeof entry.extra === 'function' ? entry.extra() : (entry.extra || {});
    publishStats(kind, entry.totals, {...base, final: true});
  }
}

// Один интервал на режим: публикует сразу и затем каждые everyMs, а stop()
// глушит таймер и пишет финальный снимок после остановки воркеров.
function startStats(kind, totals, extra, everyMs = 5000) {
  const share = () => publishStats(kind, totals, extra);
  share();
  const timer = setInterval(share, everyMs);
  if (typeof timer.unref === 'function') timer.unref();
  return {
    stop() {
      clearInterval(timer);
      const base = typeof extra === 'function' ? extra() : (extra || {});
      publishStats(kind, totals, {...base, final: true});
    }
  };
}

function loadPool() {
  const data = Store.read(POOL_FILE, {proxies: []});
  const list = Array.isArray(data) ? data : data.proxies;
  return {list: Array.isArray(list) ? list : [], meta: Array.isArray(data) ? {} : data};
}

function loadState() {
  const state = Store.read(STATE_FILE, {});
  state.accounts ||= {};
  state.clubs ||= {};
  return state;
}

// --- proxy pool -----------------------------------------------------------
// Custom lists keep credentials: paid pools authenticate with user:pass, and
// ProxyConnect already speaks SOCKS5/HTTP auth. Only the public-scraper path
// strips them, because anonymous list entries never carry credentials.
function readCustomProxies(options) {
  const raw = [];
  if (options.proxyList) {
    const text = fs.readFileSync(path.resolve(options.proxyList), 'utf8');
    raw.push(...text.split(/\s+/).filter(Boolean));
  }
  if (options.proxyUrl) {
    // fetched synchronously from the caller before buildPool runs
    raw.push(...(options.proxyUrlText || '').split(/\s+/).filter(Boolean));
  }
  const out = [];
  for (const item of raw) {
    try {
      const input = item.includes('://') ? item : `socks5://${item}`;
      const proxy = parseProxy(input);
      const auth = proxy.username
        ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@`
        : '';
      out.push(`${proxy.type}://${auth}${proxy.host}:${proxy.port}`);
    } catch {}
  }
  return [...new Set(out)];
}

// Проверка живёт в lib/ProxySync.js: pool и proxy-sync проверяют одинаково
// (ClientHello -> ServerHello через прокси).
const checkProxy = Sync.checkProxy;

async function collectCustomProxies(options) {
  if (options.proxyUrl) {
    try {
      const response = await fetch(options.proxyUrl);
      options.proxyUrlText = await response.text();
      log('pool', `свой список по ссылке: ${(options.proxyUrlText || '').split(/\s+/).filter(Boolean).length} строк`);
    } catch (error) {
      log('pool', `ссылка недоступна: ${error.message}`);
    }
  }
  const custom = readCustomProxies(options);
  if (options.proxyList) log('pool', `свой список из файла: ${custom.length}`);
  return custom;
}

async function buildPool(options) {
  const custom = await collectCustomProxies(options);
  const groups = [];
  if (custom.length) groups.push(custom);
  // Внешний конфиг идёт первым: там платные пулы с авторизацией и локальная
  // ферма, которые публичные списки всё равно не заменят.
  let config = [];
  try {
    config = Sources.loadConfig(ROOT);
  } catch (error) {
    log('pool', `конфиг: ${error.message}`);
  }
  for (const source of config) {
    if (!source.url) continue;
    try {
      const controller = new AbortController();
      const deadline = setTimeout(() => controller.abort(), 15000);
      const data = await Sources.download(source, controller.signal);
      clearTimeout(deadline);
      const group = Sources.parseText(data.text, source.protocol, {allowPrivate: source.allowPrivate, auth: source.auth || true});
      groups.push(group);
      log('pool', `${source.name}: ${group.length} кандидатов`);
    } catch (error) {
      log('pool', `${source.name}: ${error.message}`);
    }
  }
  const local = Sources.collectLocal({config});
  if (local.length) {
    groups.push(local);
    log('pool', `локальная ферма: ${local.length} кандидатов`);
  }
  for (const source of Sources.sources) {
    try {
      const controller = new AbortController();
      const deadline = setTimeout(() => controller.abort(), 15000);
      const data = await Sources.download(source, controller.signal);
      clearTimeout(deadline);
      const group = Sources.parseText(data.text, source.protocol);
      groups.push(group);
      log('pool', `${source.name}: ${group.length} кандидатов`);
    } catch (error) {
      log('pool', `${source.name}: ${error.message}`);
    }
  }
  const previous = loadPool().list;
  const candidates = Sources.select(groups, previous, options.poolCandidates, 0);
  log('pool', `проверяю ${candidates.length} кандидатов, цель ${options.poolLimit}`);

  const valid = [];
  let cursor = 0, checked = 0;
  const worker = async () => {
    while (cursor < candidates.length && valid.length < options.poolLimit) {
      const url = candidates[cursor++];
      if (await checkProxy(url, options.proxyTimeout)) {
        valid.push(url);
        if (valid.length % 10 === 0) log('pool', `рабочих ${valid.length} из ${checked} проверенных`);
      }
      checked++;
    }
  };
  await Promise.all(Array.from({length: options.poolParallel}, worker));
  Store.write(POOL_FILE, {
    checkedAt: new Date().toISOString(), checked, valid: valid.length,
    verification: 'ClientHello/ServerHello through proxy', proxies: valid
  });
  fs.writeFileSync(POOL_FILE.replace(/\.json$/, '.txt'), valid.join('\n') + (valid.length ? '\n' : ''), {mode: 0o600});
  log('pool', `готово: ${valid.length} рабочих из ${checked}`);
  return valid;
}

// --- registration ---------------------------------------------------------
const NICK_A = ['Brave','Silent','Toxic','Lucky','Mad','Sharp','Frost','Iron','Neon','Dark','Swift','Gold','Wild','Slim','Grim','Hyper','Lazy','Crazy','Royal','Rapid'];
const NICK_B = ['Wombat','Falcon','Panda','Viper','Goat','Otter','Cobra','Koala','Tiger','Raven','Wolf','Ferret','Gecko','Moose','Lynx','Jackal','Bison','Heron','Mole','Puma'];

// Random nickname so a batch of bots does not share one visible label.
function randomName() {
  const a = NICK_A[Math.floor(Math.random() * NICK_A.length)];
  const b = NICK_B[Math.floor(Math.random() * NICK_B.length)];
  const n = Math.floor(Math.random() * 9000) + 100;
  return `${a}${b}${n}`;
}

async function registerOne(index, options, poolLength) {
  const file = accountPath(index);
  const existing = Store.read(file, {});
  if (existing.passToken && (existing.hi || existing.lo)) return {index, existing: true, account: existing};

  for (let attempt = 0; attempt < options.registerAttempts; attempt++) {
    const client = new Client({
      root: ROOT,
      account: `accounts/bot-${index}.json`,
      name: options.randomNames ? randomName() : options.name,
      reconnect: false,
      // Каждая попытка берёт случайный прокси из пула: детерминированный выбор
      // возвращал тот же мёртвый прокси и сжигал все попытки впустую.
      index: poolLength ? (index + Math.floor(Math.random() * poolLength)) : index,
      proxyPoolFile: (poolLength && !options.direct) ? POOL_FILE : undefined
    });
    client.on('warning', () => {});
    try {
      await client.connect();
      if (options.region) {
        try {await Actions.execute(client, 'account-region', {region: options.region, timeout: 20000, verify: false});}
        catch (error) {if (!options.quietRegion) log('reg', `${index}: регион не применён — ${error.message}`);}
      }
      const account = Store.read(file, {});
      client.close();
      if (account.passToken && (account.hi || account.lo)) return {index, account, attempt: attempt + 1};
      return {index, error: 'сервер не выдал токен'};
    } catch (error) {
      try {client.close();} catch {}
      if (attempt === options.registerAttempts - 1) return {index, error: error.message};
      await sleep(400);
    }
  }
  return {index, error: 'попытки исчерпаны'};
}

async function registerBulk(indexes, options) {
  const {list} = loadPool();
  if (!list.length) throw new Error('Пул пуст: сначала соберите прокси (команда pool)');
  log('reg', `регистрирую ${indexes.length} аккаунтов через ${list.length} прокси, поток ${options.concurrency}`);
  const byIndex = new Map();

  const runWave = async (todo, wave) => {
    let cursor = 0;
    const worker = async () => {
      while (cursor < todo.length) {
        const index = todo[cursor++];
        const result = await registerOne(index, options, list.length);
        byIndex.set(index, result);
        const account = result.account || Store.read(accountPath(index), {});
        const tag = account.lo ? require('../utils/TagCodec').logicLongToTag(account.hi, account.lo) : null;
        log('reg', result.error
          ? `${index}: ошибка — ${result.error}`
          : `${index}: ${tag || '?'} ${account.name || ''}${result.existing ? ' (уже был)' : ''}`);
        await sleep(100);
      }
    };
    await Promise.all(Array.from({length: options.concurrency}, worker));
  };

  await runWave(indexes, 0);

  // Вторая волна только по провалившимся: свежие случайные прокси, те же попытки.
  const failed = [...byIndex.values()].filter(r => r.error).length;
  if (failed) {
    const retry = [...byIndex.entries()].filter(([, r]) => r.error).map(([index]) => index);
    log('reg', `вторая волна: ${retry.length}`);
    await runWave(retry, 1);
  }

  const results = [...byIndex.values()];
  const errors = results.filter(r => r.error).length;
  log('reg', `готово: ${results.length - errors} ок, ${errors} ошибок`);
  return results;
}

// --- account region -------------------------------------------------------
async function setRegionBulk(indexes, options) {
  const {list} = loadPool();
  const targets = indexes.filter(index => {
    const account = Store.read(accountPath(index), {});
    return account.passToken && (account.hi || account.lo);
  });
  log('region', `${targets.length} аккаунтов → ${options.region}, поток ${options.concurrency}, прокси ${list.length}`);
  let cursor = 0;
  const stats = {ok: 0, failed: 0};
  const worker = async () => {
    while (cursor < targets.length) {
      const index = targets[cursor++];
      const account = Store.read(accountPath(index), {});
      let applied = false, last = null;
      for (let attempt = 0; attempt < options.regionAttempts && !applied; attempt++) {
        const client = new Client({
          root: ROOT, account: `accounts/bot-${index}.json`, name: account.name,
          reconnect: false, index: index + attempt * Math.max(1, list.length),
          proxyPoolFile: (list.length && !options.direct) ? POOL_FILE : undefined
        });
        client.on('warning', () => {});
        try {
          await client.connect();
          await Actions.execute(client, 'account-region', {region: options.region, timeout: 20000, verify: false});
          applied = true;
        } catch (error) {
          last = error;
        } finally {
          try {client.close();} catch {}
        }
        if (!applied) await sleep(300);
      }
      if (applied) {
        stats.ok++;
        if (options.verbose) log('region', `${index}: ${options.region} ✓`);
      } else {
        stats.failed++;
        log('region', `${index}: ${last?.message || 'не подтверждено'}`);
      }
    }
  };
  await Promise.all(Array.from({length: options.concurrency}, worker));
  log('region', `готово: ${stats.ok} подтверждено, ${stats.failed} ошибок`);
}

// --- single club attack ---------------------------------------------------
// One club tag, many accounts: every bot joins, holds the club and fires the
// message at the shared rate budget until the run is stopped.
async function attackClub(options, indexes) {
  if (!options.club) throw new Error('Укажите тег клуба: --club #TAG');
  const clubTag = clubTagOf(options.club);
  if (!/^#[0-9A-Z]{3,12}$/.test(clubTag)) throw new Error(`Неверный тег клуба: ${options.club}`);
  const {list} = loadPool();
  const deadline = options.minutes > 0 ? Date.now() + options.minutes * 60000 : Infinity;
  const shouldStop = () => Date.now() >= deadline;
  const gate = new RateGate(options.maxRate);

  const accounts = indexes.filter(index => {
    const account = Store.read(accountPath(index), {});
    return account.passToken && (account.hi || account.lo);
  });
  const roster = options.bots > 0 ? accounts.slice(0, options.bots) : accounts;

  const state = loadState();
  const totals = {messages: 0, joins: 0, rejects: 0, exits: 0, online: 0};
  // Заголовок клуба приходит в ответе 24399 на вход: имя, тип, места, порог.
  // Отсюда бот узнаёт настоящий клуб, даже когда справка 24301 молчит.
  const clubMeta = {name: null, type: 0, members: 0, required: 0, code: 0};
  const stayInside = options.exitMode === 'end' || options.exitMode === 'never';
  const stats = startStats('attack', totals, clubMeta);
  log('attack', `клуб ${clubTag}, ботов ${roster.length}, поток ${options.concurrency}, лимит ${options.maxRate} пакетов/с, цикл ${options.messageCycle} сообщений, лимит прогона ${options.minutes ? options.minutes + ' мин' : 'до стопа'}`);

  let cursor = 0;
  let lastScale = 1;
  const worker = async () => {
    while (!shouldStop() && !stopping.value && cursor < roster.length) {
      const index = roster[cursor++];
      const account = Store.read(accountPath(index), {});
      let rejects = 0;
      const client = new Client({
        root: ROOT, account: `accounts/bot-${index}.json`, name: account.name,
        reconnect: true, index, proxyPoolFile: (list.length && !options.direct) ? POOL_FILE : undefined
      });
      client.on('warning', () => {});
      totals.online++;
      try {
        await client.connect();
        while (!shouldStop() && !stopping.value) {
          if (client.state !== 'online') {await sleep(1000); continue;}
          if (!client.club) {
            try {
              await Actions.execute(client, 'join-club', {clubTag, timeout: 20000});
              totals.joins++;
              rejects = 0;
              clubMeta.code = 0;
              if (client.club) {
                clubMeta.name = client.club.name || null;
                clubMeta.type = Number(client.club.type || 0);
                clubMeta.members = Number(client.club.memberCount || 0);
                clubMeta.required = Number(client.club.requiredTrophies || 0);
              }
              log('attack', `${index}: вошёл в ${clubTag}`);
            } catch (error) {
              totals.rejects++;
              const refused = /ответ клуба (\d+)/.exec(error.message);
              if (refused) clubMeta.code = Number(refused[1]);
              // "Team is full"/42 means a free slot just got taken: retry almost
              // immediately instead of growing a backoff, otherwise the queue
              // crawls whenever the club has one or two seats.
              const busy = /ответ клуба 42|Team is full|полн/i.test(error.message);
              const delay = busy
                ? 250 + Math.floor(Math.random() * 350)
                : Math.min(3000 * 2 ** Math.min(rejects++, 4), 30000);
              if (!busy) log('attack', `${index}: вход отклонён (${Math.round(delay / 1000)}с) — ${error.message}`);
              await sleep(delay);
              continue;
            }
          }
          let sent = 0;
          const ctl = controlReader(options.control)();
          if (ctl.stop) break;
          if (ctl.scale !== lastScale) {
            lastScale = ctl.scale;
            log('attack', `${index}: интенсивность ${Math.round(ctl.scale * 100)}%`);
          }
          const limit = options.messageCycle > 0
            ? Math.max(1, Math.round(options.messageCycle * ctl.scale))
            : Infinity;
          if (options.silent) {
            await sleep(Math.max(300, options.spamWindowMs || 1000));
          } else while (!shouldStop() && !stopping.value && client.state === 'online' && sent < limit) {
            await gate.take();
            try {
              const message = Protocol.encode('club-chat', {text: options.spamText});
              client.messaging.send(message.id, message.payload, message.version);
              totals.messages++;
              sent++;
            } catch (error) {
              log('attack', `${index}: отправка — ${error.message}`);
              break;
            }
            if (options.burstDelay > 0) await sleep(options.burstDelay);
          }
          // Visit quota reached: drop the club right away and re-enter on the
          // next pass, so nobody sits long enough to be caught by a kick.
          // В режимах end/never бот остаётся внутри весь прогон.
          if (!stayInside && client.state === 'online' && client.club) {
            try {
              const bye = Protocol.encode('leave-club', {});
              client.messaging.send(bye.id, bye.payload, bye.version);
            } catch {}
            client.club = null;
            totals.exits++;
            if (options.cycleDelay > 0) await sleep(options.cycleDelay);
          }
        }
      } catch (error) {
        log('attack', `${index}: сессия — ${error.message}`);
      } finally {
        // Выход из клуба перед закрытием сессии: при exit-mode=never членство
        // остаётся, при end — боты выходят только сейчас.
        if (options.exitMode !== 'never' && client.state === 'online' && client.club) {
          try {
            const bye = Protocol.encode('leave-club', {});
            client.messaging.send(bye.id, bye.payload, bye.version);
            totals.exits++;
          } catch {}
          client.club = null;
        }
        try {client.close();} catch {}
        totals.online--;
        state.accounts[index] = {at: new Date().toISOString(), club: clubTag};
        Store.write(STATE_FILE, state);
      }
    }
  };

  const reporter = setInterval(() => {
    log('attack', `${clubTag}: онлайн ${totals.online}, входов ${totals.joins}, выходов ${totals.exits}, отказов ${totals.rejects}, отправлено ${totals.messages}`);
    state.totals = {at: new Date().toISOString(), club: clubTag, ...totals};
    Store.write(STATE_FILE, state);
  }, 15000);

  try {
    await Promise.all(Array.from({length: Math.min(options.concurrency, roster.length)}, worker));
  } finally {
    clearInterval(reporter);
    stats.stop();
  }
  log('attack', `итого ${clubTag}: отправлено ${totals.messages}, входов ${totals.joins}, отказов ${totals.rejects}`);
  state.totals = {at: new Date().toISOString(), club: clubTag, ...totals};
  Store.write(STATE_FILE, state);
}

// --- club check -----------------------------------------------------------
// Read-only probe used before an attack: is the club open, joinable and free.
async function checkClub(options) {
  const tag = clubTagOf(options.club);
  const {list} = loadPool();
  const account = options.account || 'accounts/bot-1.json';
  const client = new Client({
    root: ROOT, account, reconnect: false, index: 1,
    proxyPoolFile: (list.length && !options.direct) ? POOL_FILE : undefined
  });
  client.on('warning', () => {});
  try {
    await client.connect();
    const result = await Actions.execute(client, 'club-info', {clubTag: tag, timeout: 25000});
    const club = result.club || {};
    const members = club.memberCount || 0;
    // Клуб закрытый или с порогом сервер отдаёт без имени, но с типом и составом:
    // существование определяем по любому признаку, а не только по названию.
    const exists = Boolean(club.name || club.type || members || club.hi || club.lo);
    return {
      tag, exists, name: club.name || null, type: club.type || null,
      members, limit: 100, free: Math.max(0, 100 - members),
      required: club.requiredTrophies || 0,
      open: club.type === 1 && (club.requiredTrophies || 0) === 0 && members < 100
    };
  } catch (error) {
    // Сервер мог не ответить — это не «клуба нет».
    return {tag, exists: null, error: error.message};
  } finally {try {client.close();} catch {}}
}

// --- lobby rush -----------------------------------------------------------
// One room code: bots keep entering, firing a quota of messages and leaving,
// then repeat. Nothing sticks, so a kick has nothing to catch.
async function lobbyRush(options, indexes) {
  if (!options.code) throw new Error('Укажите код комнаты: --code X...');
  const code = String(options.code).trim().toUpperCase();
  if (!/^X[A-Z2-9]{1,12}$/.test(code)) throw new Error(`Неверный код комнаты: ${code}`);
  const {list} = loadPool();
  const roster = indexes.filter(index => {
    const account = Store.read(accountPath(index), {});
    return account.passToken && (account.hi || account.lo);
  });
  const players = options.bots > 0 ? roster.slice(0, options.bots) : roster;
  const deadline = options.minutes > 0 ? Date.now() + options.minutes * 60000 : Infinity;
  const shouldStop = () => Date.now() >= deadline;
  const gate = new RateGate(options.maxRate);

  let permits = Math.max(1, options.joinParallel);
  const queue = [];
  const acquire = async () => {if (permits > 0) {permits--; return;} await new Promise(r => queue.push(r));};
  const release = () => {const next = queue.shift(); if (next) next(); else permits++;};

  const totals = {online: 0, joins: 0, exits: 0, rejects: 0, messages: 0};
  const stats = startStats('lobby', totals);
  log('lobby', `комната ${code}, ботов ${players.length}, цикл ${options.messageCycle} сообщений, лимит ${options.maxRate}/с, текст ${JSON.stringify(options.spamText)}`);
  let cursor = 0;

  const worker = async () => {
    while (!shouldStop() && !stopping.value && cursor < players.length) {
      const index = players[cursor++];
      const account = Store.read(accountPath(index), {});
      const client = new Client({
        root: ROOT, account: `accounts/bot-${index}.json`, name: account.name,
        reconnect: true, index, proxyPoolFile: (list.length && !options.direct) ? POOL_FILE : undefined
      });
      client.on('warning', () => {});
      try {
        await acquire();
        try {await client.connect();} finally {release();}
        totals.online++;
        while (!shouldStop() && !stopping.value) {
          if (client.state !== 'online') {await sleep(1000); continue;}
          if (!client.team || client.team.code !== code) {
            await acquire();
            try {
              await Actions.execute(client, 'join-room', {code, timeout: 20000});
              totals.joins++;
            } catch (error) {
              totals.rejects++;
              release();
              await sleep(3000 + Math.floor(Math.random() * 1500));
              continue;
            }
            release();
          }
          let sent = 0;
          const limit = options.messageCycle > 0 ? options.messageCycle : Infinity;
          if (options.silent) {
            await sleep(Math.max(300, options.spamWindowMs || 1000));
          } else while (!shouldStop() && !stopping.value && client.state === 'online' && sent < limit) {
            await gate.take();
            try {
              const message = Protocol.encode('chat', {text: options.spamText});
              client.messaging.send(message.id, message.payload, message.version);
              totals.messages++;
              sent++;
            } catch (error) {break;}
            if (options.burstDelay > 0) await sleep(options.burstDelay);
          }
          try {
            const bye = Protocol.encode('leave-room', {});
            client.messaging.send(bye.id, bye.payload, bye.version);
          } catch {}
          client.team = null;
          totals.exits++;
          if (options.cycleDelay > 0) await sleep(options.cycleDelay);
        }
      } catch (error) {
        log('lobby', `${index}: сессия — ${error.message}`);
      }
    }
  };

  const reporter = setInterval(() => {
    log('lobby', `онлайн ${totals.online}, входов ${totals.joins}, выходов ${totals.exits}, отказов ${totals.rejects}, отправлено ${totals.messages}`);
  }, 15000);

  try {
    await Promise.all(Array.from({length: Math.min(options.concurrency, players.length)}, worker));
  } finally {
    clearInterval(reporter);
    stats.stop();
  }
  log('lobby', `итого: отправлено ${totals.messages}, входов ${totals.joins}, выходов ${totals.exits}`);
}

// --- spectate target ------------------------------------------------------
// Holds a spectator session on one player: while the target is in a battle the
// server keeps the stream open, and each bot retries when the target is idle.
async function watchTarget(options, indexes) {
  if (!options.tag) throw new Error('Укажите тег цели: --tag #TAG');
  const target = clubTagOf(options.tag);
  const {list} = loadPool();
  const roster = indexes.filter(index => {
    const account = Store.read(accountPath(index), {});
    return account.passToken && (account.hi || account.lo);
  });
  const viewers = options.bots > 0 ? roster.slice(0, options.bots) : roster;
  const deadline = options.minutes > 0 ? Date.now() + options.minutes * 60000 : Infinity;
  const shouldStop = () => Date.now() >= deadline;

  let permits = Math.max(1, options.joinParallel);
  const queue = [];
  const acquire = async () => {if (permits > 0) {permits--; return;} await new Promise(r => queue.push(r));};
  const release = () => {const next = queue.shift(); if (next) next(); else permits++;};

  const totals = {online: 0, watching: 0, idle: 0, failed: 0};
  const stats = startStats('watch', totals);
  log('watch', `цель ${target}, наблюдателей ${viewers.length}, параллельно ${permits}`);
  const clients = [];

  const worker = async (index) => {
    const account = Store.read(accountPath(index), {});
    const client = new Client({
      root: ROOT, account: `accounts/bot-${index}.json`, name: account.name,
      reconnect: true, index, proxyPoolFile: (list.length && !options.direct) ? POOL_FILE : undefined
    });
    client.on('warning', () => {});
    clients.push(client);
    let watching = false;
    const setWatching = value => {
      if (watching === value) return;
      watching = value;
      totals.watching = Math.max(0, totals.watching + (value ? 1 : -1));
    };
    // Battle end, home reload or a closed team means the camera is gone; the
    // next loop iteration re-enters spectate instead of sitting on a dead one.
    client.on('packet', packet => {
      // 23456 arrives mid-battle as well, so it must not tear the camera down.
      // The session is dropped only when the server re-opens Home, closes the
      // team, or the stream goes silent (checked by the idle timeout).
      if ([24101, 24125].includes(packet.type)) {
        if (watching) log('watch', `${index}: камера закрыта пакетом ${packet.type}`);
        setWatching(false);
      }
    });
    try {
      await acquire();
      try {await client.connect();} finally {release();}
      totals.online++;
      while (!shouldStop() && !stopping.value) {
        if (client.state !== 'online') {setWatching(false); await sleep(1000); continue;}
        if (watching) {
          const silent = client.lastServerAt ? Date.now() - new Date(client.lastServerAt).getTime() : 0;
          if (silent > options.watchTimeout) {
            setWatching(false);
            log('watch', `${index}: тишина ${Math.round(silent / 1000)}с — переподключаюсь`);
          }
        }
        if (!watching) {
          await acquire();
          try {
            await Actions.execute(client, 'spectate', {tag: target, timeout: 20000});
            setWatching(true);
            log('watch', `${index}: наблюдает за ${target}`);
          } catch (error) {
            totals.failed++;
            if (totals.failed <= 5) log('watch', `${index}: цель вне боя — ${error.message}`);
            await sleep(5000);
            release();
            continue;
          }
          release();
        }
        await sleep(10000);
      }
    } catch (error) {
      log('watch', `${index}: сессия — ${error.message}`);
    }
  };

  const reporter = setInterval(() => {
    log('watch', `онлайн ${totals.online}, в наблюдении ${totals.watching}, попыток мимо ${totals.failed}`);
  }, 15000);

  try {
    await Promise.all(viewers.map(worker));
  } finally {
    clearInterval(reporter);
    stats.stop();
  }
  log('watch', `итого: онлайн ${totals.online}, наблюдали ${totals.watching}, мимо ${totals.failed}`);
  for (const client of clients) {try {client.close();} catch {}}
}

// --- occupy club ----------------------------------------------------------
// Every account joins one club, says one line, then stays online. Joins are
// paced so the server does not slam the door with rate-limit codes.
async function occupyClub(options, indexes) {
  if (!options.club) throw new Error('Укажите клуб: --club #TAG');
  const clubTag = clubTagOf(options.club);
  const {list} = loadPool();
  const roster = indexes.filter(index => {
    const account = Store.read(accountPath(index), {});
    return account.passToken && (account.hi || account.lo);
  });
  // Accounts already recorded as members must not re-run join-club: the server
  // answers 46 for an existing member, which used to read as a failure.
  const targetId = require('../utils/TagCodec').tagToLogicLong(clubTag);
  const isMember = index => {
    const account = Store.read(accountPath(index), {});
    const club = account.club;
    return !!(club && club.hi === targetId.hi && club.lo === targetId.lo);
  };
  let members = roster.filter(isMember);
  if (!options.membersOnly) {
    const rest = roster.filter(index => !isMember(index));
    members = members.concat(rest);
  }
  if (options.bots > 0) members = members.slice(0, options.bots);
  log('occupy', `уже в клубе: ${roster.filter(isMember).length}`);
  const deadline = options.minutes > 0 ? Date.now() + options.minutes * 60000 : Infinity;
  const shouldStop = () => Date.now() >= deadline;

  // join pacing
  let permits = Math.max(1, options.joinParallel);
  const queue = [];
  const acquire = async () => {
    if (permits > 0) {permits--; return;}
    await new Promise(resolve => queue.push(resolve));
  };
  const release = () => {
    const next = queue.shift();
    if (next) next(); else permits++;
  };

  const totals = {online: 0, joined: 0, sent: 0, failed: 0};
  // Панель ждёт ключ said: движок считает его в sent, публикуем оба, не меняя счётчик.
  const stats = startStats('occupy', totals, () => ({said: totals.sent}));
  log('occupy', `клуб ${clubTag}, аккаунтов ${members.length}, входов параллельно ${permits}, текст ${JSON.stringify(options.text)}`);

  const clients = [];
  const worker = async (index) => {
    const account = Store.read(accountPath(index), {});
    const client = new Client({
      root: ROOT, account: `accounts/bot-${index}.json`, name: account.name,
      reconnect: true, index, proxyPoolFile: (list.length && !options.direct) ? POOL_FILE : undefined
    });
    client.on('warning', () => {});
    clients.push(client);
    try {
      await client.connect();
      totals.online++;
      let said = false, inClub = false, rejects = 0;
      const setInClub = value => {
        if (inClub === value) return;
        inClub = value;
        totals.joined = Math.max(0, totals.joined + (value ? 1 : -1));
      };
      setInClub(isMember(index) || false);
      // Server drops membership on its own (idle, member cap, rejoin rate) —
      // the flag follows the real state instead of accumulating forever.
      client.on('packet', packet => {
        if ([24399, 24125].includes(packet.type) && !client.club) setInClub(false);
      });
      while (!shouldStop() && !stopping.value) {
        if (client.state !== 'online') {setInClub(false); await sleep(1000); continue;}
        if (!inClub) {
          await acquire();
          try {
            await Actions.execute(client, 'join-club', {clubTag, timeout: 20000});
            setInClub(true);
            rejects = 0;
            log('occupy', `${index}: в клубе ${clubTag}`);
          } catch (error) {
            totals.failed++;
            const delay = Math.min(3000 * 2 ** Math.min(rejects++, 3), 20000) + Math.floor(Math.random() * 800);
            log('occupy', `${index}: отказ (${Math.round(delay / 1000)}с) — ${error.message}`);
            await sleep(delay);
            release();
            continue;
          }
          release();
        }
        if (!said && options.text) {
          try {
            await Actions.execute(client, 'club-chat', {text: options.text, timeout: 15000});
            totals.sent++;
            said = true;
            log('occupy', `${index}: отправил ${JSON.stringify(options.text)}`);
          } catch (error) {
            log('occupy', `${index}: сообщение не прошло — ${error.message}`);
          }
        }
        await sleep(5000);
      }
    } catch (error) {
      log('occupy', `${index}: сессия — ${error.message}`);
    }
  };

  const reporter = setInterval(() => {
    log('occupy', `онлайн ${totals.online}, в клубе ${totals.joined}, сказали ${totals.sent}, отказов ${totals.failed}`);
  }, 15000);

  try {
    await Promise.all(members.map(worker));
  } finally {
    clearInterval(reporter);
    stats.stop();
  }
  log('occupy', `итого: онлайн ${totals.online}, в клубе ${totals.joined}, сказали ${totals.sent}, отказов ${totals.failed}`);
  for (const client of clients) {try {client.close();} catch {}}
}

// --- friend requests ------------------------------------------------------
// Bots send friend requests to one player tag. Nothing is joined, nothing is
// left: the target just gets a stream of incoming requests.
async function friendSpam(options, indexes) {
  if (!options.tag) throw new Error('Укажите тег игрока: --tag #TAG');
  const target = clubTagOf(options.tag);
  const {list} = loadPool();
  const roster = indexes.filter(index => {
    const account = Store.read(accountPath(index), {});
    return account.passToken && (account.hi || account.lo);
  });
  const members = options.bots > 0 ? roster.slice(0, options.bots) : roster;
  const deadline = options.minutes > 0 ? Date.now() + options.minutes * 60000 : Infinity;
  const shouldStop = () => Date.now() >= deadline || stopping.value;
  const delay = Math.max(1500, Number(options.requestDelay || 8000));
  const totals = {online: 0, sent: 0, rejects: 0};
  const stats = startStats('friends', totals);
  log('friends', `цель ${target}, ботов ${members.length}, пауза ${delay} мс`);
  let cursor = 0;

  const worker = async () => {
    while (!shouldStop() && cursor < members.length) {
      const index = members[cursor++];
      const account = Store.read(accountPath(index), {});
      const client = new Client({
        root: ROOT, account: `accounts/bot-${index}.json`, name: account.name,
        reconnect: true, index, proxyPoolFile: (list.length && !options.direct) ? POOL_FILE : undefined
      });
      client.on('warning', () => {});
      try {
        await client.connect();
        totals.online++;
        // Уже друг или заявка висит — сервер ответ не пришлёт, и это не ошибка.
        let known = false;
        try {
          await Actions.execute(client, 'friends', {timeout: 15000});
          const who = require('../utils/TagCodec').tagToLogicLong(target);
          const found = (client.friends || []).find(f => f.lo === who.lo && f.hi === who.hi);
          known = !!found && Number(found.relationship) >= 2;
        } catch {}
        if (known) {
          totals.skipped = (totals.skipped || 0) + 1;
          log('friends', `${index}: уже в друзьях или заявка висит — пропускаю`);
          try {client.close();} catch {}
          continue;
        }
        while (!shouldStop()) {
          if (client.state !== 'online') {await sleep(1500); continue;}
          let backoff = delay;
          try {
            await Actions.execute(client, 'friend', {tag: target, reason: 0, timeout: 9000});
            totals.sent++;
          } catch (error) {
            // Молчание сервера на повторную заявку — не отказ, просто ждём дольше.
            if (/подтверждения|20106|timeout/i.test(error.message)) {
              totals.sent++;
              backoff = Math.max(delay, 30000);
            } else {
              totals.rejects++;
              if (totals.rejects <= 5) log('friends', `${index}: заявка не ушла — ${error.message}`);
            }
          }
          await sleep(backoff);
        }
      } catch (error) {
        log('friends', `${index}: сессия — ${error.message}`);
      }
    }
  };

  const reporter = setInterval(() => {
    log('friends', `онлайн ${totals.online}, заявок в друзья ${totals.sent}, отказов ${totals.rejects}`);
  }, 15000);

  try {
    await Promise.all(Array.from({length: Math.min(options.concurrency, members.length)}, worker));
  } finally {
    clearInterval(reporter);
    stats.stop();
  }
  log('friends', `итого: онлайн ${totals.online}, заявок в друзья ${totals.sent}, отказов ${totals.rejects}`);
}

// --- club list ------------------------------------------------------------
// One account asks the server for recommended clubs and prints them: that is
// the only way to get a club list without already knowing tags.
async function listClubs(options, indexes) {
  const {list} = loadPool();
  const TagCodec = require('../utils/TagCodec');
  const index = indexes[0];
  const account = Store.read(accountPath(index), {});
  if (!account.passToken || (!account.hi && !account.lo)) throw new Error(`аккаунт ${index} не зарегистрирован`);
  const client = new Client({
    root: ROOT, account: `accounts/bot-${index}.json`, name: account.name, reconnect: false, index,
    proxyPoolFile: (list.length && !options.direct) ? POOL_FILE : undefined
  });
  client.on('warning', () => {});
  try {
    await client.connect();
    const result = await Actions.execute(client, 'club-recommendations', {timeout: 25000});
    const raw = result.clubs || [];
    // Рекомендации врут про тип клуба (24304 отдаёт не join-тип), поэтому
    // по каждому проверяем реальные данные через club-info.
    const detailed = [];
    // Строго по одному: параллельные ответы одного типа на одном соединении
    // могут перепутаться, и тогда клуб получает чужое имя и счётчик.
    for (const club of raw) {
      const tag = '#' + String(TagCodec.logicLongToTag(club.hi, club.lo)).replace(/^#/, '');
      let entry = {tag, name: club.name, type: null, members: club.memberCount, limit: 100,
        free: Math.max(0, 100 - club.memberCount), required: club.requiredTrophies || 0, open: false, unchecked: true};
      try {
        const info = await Actions.execute(client, 'club-info', {clubTag: tag, timeout: 12000});
        const data = info.club || {};
        const same = data.hi === club.hi && data.lo === club.lo;
        if (same) {
          const members = data.memberCount ?? club.memberCount;
          const required = data.requiredTrophies ?? 0;
          entry = {
            tag, name: data.name || club.name, type: data.type,
            members, limit: 100, free: Math.max(0, 100 - members),
            trophies: data.trophies ?? club.trophies, required,
            open: data.type === 1 && required === 0 && members < 100
          };
        }
      } catch {}
      detailed.push(entry);
    }
    const clubs = detailed
      .filter(club => !options.openOnly || club.open)
      .sort((a, b) => b.members - a.members);

    if (options.json) {
      console.log(JSON.stringify({account: index, count: clubs.length, clubs: clubs.slice(0, options.clubLimit)}, null, 2));
      return;
    }
    log('clubs', `аккаунт ${index}, проверено ${detailed.length}, подходит ${clubs.length}`);
    for (const club of clubs.slice(0, options.clubLimit)) {
      const state = club.open ? 'открыт' : (club.free === 0 ? 'полон' : club.type === 2 ? 'по заявкам' : club.required > 0 ? 'порог' : 'закрыт');
      console.log(`${club.tag.padEnd(15)} ${String(club.members).padStart(3)}/100  ${state.padEnd(10)} порог ${String(club.required).padStart(5)}  ${club.name}`);
    }
  } finally {try {client.close();} catch {}}
}

// --- request spam ---------------------------------------------------------
// Bots send membership requests instead of joining. If a club accepts one, the
// bot sees itself as a member and leaves immediately, so the seat stays free.
async function requestSpam(options, indexes) {
  if (!options.club) throw new Error('Укажите клуб: --club #TAG');
  const clubTag = clubTagOf(options.club);
  const {list} = loadPool();
  const roster = indexes.filter(index => {
    const account = Store.read(accountPath(index), {});
    return account.passToken && (account.hi || account.lo);
  });
  const members = options.bots > 0 ? roster.slice(0, options.bots) : roster;
  const text = options.spamText || 'ишак получил $win';
  const deadline = options.minutes > 0 ? Date.now() + options.minutes * 60000 : Infinity;
  const shouldStop = () => Date.now() >= deadline;
  const delay = Math.max(1500, Number(options.requestDelay || 6000));

  const totals = {online: 0, sent: 0, accepted: 0, rejects: 0};
  const stats = startStats('requests', totals);
  log('requests', `клуб ${clubTag}, ботов ${members.length}, текст ${JSON.stringify(text)}`);
  let cursor = 0;

  const worker = async () => {
    while (!shouldStop() && !stopping.value && cursor < members.length) {
      const index = members[cursor++];
      const account = Store.read(accountPath(index), {});
      const client = new Client({
        root: ROOT, account: `accounts/bot-${index}.json`, name: account.name,
        reconnect: true, index, proxyPoolFile: (list.length && !options.direct) ? POOL_FILE : undefined
      });
      client.on('warning', () => {});
      try {
        await client.connect();
        totals.online++;
        while (!shouldStop() && !stopping.value) {
          if (client.state !== 'online') {await sleep(1500); continue;}
          try {await Actions.execute(client, 'club-info', {clubTag, timeout: 15000});} catch {}
          if (client.club) {
            // accepted — free the slot at once
            totals.accepted++;
            try {await Actions.execute(client, 'leave-club', {timeout: 15000});} catch {}
            log('requests', `${index}: приняли, вышел из ${clubTag}`);
          }
          let backoff = delay;
          try {
            await Actions.execute(client, 'club-request', {clubTag, text, timeout: 20000});
            totals.sent++;
          } catch (error) {
            // 52 — заявка уже висит (значит текст доставлен), 53 — сервер отказал:
            // чаще всего порог кубков или закрытый тип, долбить каждые 6 с нет смысла.
            const code = Number((String(error.message).match(/(\d+)\s*$/) || [])[1]);
            if (code === 52) {
              // заявка уже висит — текст доставлен, повторять нечего
              totals.sent++;
            } else {
              totals.rejects++;
              if (code === 53) backoff = Math.max(delay, 30000);
              if (totals.rejects <= 5) log('requests', `${index}: заявка не ушла — ${error.message}${code === 53 ? ' (отказ сервера: порог или тип клуба)' : ''}`);
            }
          }
          await sleep(backoff);
        }
      } catch (error) {
        log('requests', `${index}: сессия — ${error.message}`);
      }
    }
  };

  const reporter = setInterval(() => {
    log('requests', `онлайн ${totals.online}, заявок ${totals.sent}, приняли ${totals.accepted}, отказов ${totals.rejects}`);
  }, 15000);

  try {
    await Promise.all(Array.from({length: Math.min(options.concurrency, members.length)}, worker));
  } finally {
    clearInterval(reporter);
    stats.stop();
  }
  log('requests', `итого: заявок ${totals.sent}, приняли ${totals.accepted}, отказов ${totals.rejects}`);
}

// --- club invites ---------------------------------------------------------
// Pulls candidate tags from the leaderboard and sends club invitations from
// bots that are members of the target club. Server answer is reported as is.
async function inviteBulk(options, indexes) {
  if (!options.club) throw new Error('Укажите клуб: --club #TAG');
  const clubTag = clubTagOf(options.club);
  const {list} = loadPool();
  const roster = indexes.filter(index => {
    const account = Store.read(accountPath(index), {});
    return account.passToken && (account.hi || account.lo);
  });
  const senders = roster.slice(0, Math.max(1, options.bots));

  // candidates: leaderboard first, then club members of the target club
  const scout = new Client({
    root: ROOT, account: `accounts/bot-${senders[0]}.json`, reconnect: false,
    index: senders[0], proxyPoolFile: (list.length && !options.direct) ? POOL_FILE : undefined
  });
  scout.on('warning', () => {});
  await scout.connect();
  let targets = [];
  try {
    const top = await Actions.execute(scout, 'top', {type: 0, timeout: 30000});
    targets = (top.leaderboard?.entries || []).map(entry => entry.tag).filter(Boolean);
  } catch (error) {
    log('invite', `топ недоступен: ${error.message}`);
  }
  try {scout.close();} catch {}
  const own = new Set(roster.map(index => Store.read(accountPath(index), {})).filter(a => a.lo).map(a => require('../utils/TagCodec').logicLongToTag(a.hi, a.lo)));
  targets = [...new Set(targets)].filter(tag => !own.has(tag)).slice(0, options.limit);
  log('invite', `клуб ${clubTag}, отправителей ${senders.length}, целей ${targets.length}`);

  const totals = {sent: 0, failed: 0};
  const stats = startStats('invite', totals);
  let cursor = 0;
  const worker = async (index) => {
    const account = Store.read(accountPath(index), {});
    const client = new Client({
      root: ROOT, account: `accounts/bot-${index}.json`, name: account.name,
      reconnect: false, index, proxyPoolFile: (list.length && !options.direct) ? POOL_FILE : undefined
    });
    client.on('warning', () => {});
    try {
      await client.connect();
      try {await Actions.execute(client, 'join-club', {clubTag, timeout: 25000});} catch {}
      while (cursor < targets.length) {
        const tag = targets[cursor++];
        try {
          await Actions.execute(client, 'club-invite', {tag, experimental: true, timeout: 20000});
          totals.sent++;
        } catch (error) {
          totals.failed++;
          if (totals.failed <= 5) log('invite', `${index} → ${tag}: ${error.message}`);
        }
        if (options.burstDelay > 0) await sleep(options.burstDelay);
      }
    } catch (error) {
      log('invite', `${index}: сессия — ${error.message}`);
    } finally {
      try {client.close();} catch {}
    }
  };
  try {
    await Promise.all(senders.map(worker));
  } finally {
    stats.stop();
  }
  log('invite', `итого: отправлено ${totals.sent}, отказов ${totals.failed}`);
}

// --- club raid ------------------------------------------------------------
// Shared rotation: the scout rewrites the list every refresh interval, workers
// pull the next club from the same cursor so the whole list gets covered.
class Rotation {
  constructor() {
    this.clubs = [];
    this.cursor = 0;
    this.version = 0;
    this.updatedAt = null;
    this.maxClubs = null;
  }

  update(clubs) {
    this.clubs = clubs;
    this.version++;
    this.updatedAt = new Date().toISOString();
  }

  next() {
    if (!this.clubs.length) return null;
    const club = this.clubs[this.cursor % this.clubs.length];
    this.cursor = (this.cursor + 1) % Number.MAX_SAFE_INTEGER;
    return club;
  }

  get size() {return this.clubs.length;}
}

async function startScout(options, rotation, shouldStop) {
  const index = options.first + options.count; // dedicated connection, outside the worker range
  const {list} = loadPool();
  if (!Store.read(accountPath(index), {}).passToken) {
    const created = await registerOne(index, options, list.length);
    if (created.error) throw new Error(`аккаунт-разведчик не создан: ${created.error}`);
  }
  const client = new Client({
    root: ROOT, account: `accounts/bot-${index}.json`, reconnect: false,
    index, proxyPoolFile: POOL_FILE
  });
  client.on('warning', () => {});
  await client.connect();
  const loop = (async () => {
    while (!shouldStop() && !stopping.value) {
      try {
        const result = await Actions.execute(client, 'club-recommendations', {timeout: 20000});
        const all = result.clubs || [];
        const open = all.filter(club => club.type === 1);
        rotation.update(options.allClubs ? open : open.slice(0, options.clubLimit));
        log('scout', `рекомендаций ${all.length}, открытых ${open.length}, в ротации ${rotation.size}`);
      } catch (error) {
        log('scout', `обновление не удалось: ${error.message}`);
      }
      await sleep(options.refreshMs);
    }
    try {client.close();} catch {}
  })();
  return {client, loop};
}

// Файл управления: панель пишет {scale: 0.25..1, stop: bool}, движок читает
// его раз в 1.5 с и подстраивает интенсивность на ходу, без перезапуска.
function controlReader(file) {
  let cache = {at: 0, scale: 1, stop: false};
  if (!file) return () => cache;
  return () => {
    if (Date.now() - cache.at < 1500) return cache;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      const scale = Number(raw.scale);
      cache = {
        at: Date.now(),
        scale: Number.isFinite(scale) ? Math.min(1, Math.max(0.1, scale)) : cache.scale,
        stop: !!raw.stop
      };
    } catch {cache = {at: Date.now(), scale: cache.scale, stop: cache.stop};}
    return cache;
  };
}

// Global token gate: the box cannot encrypt an unbounded packet stream, so the
// burst rate is capped for the whole fleet instead of per bot.
class RateGate {
  constructor(perSecond) {
    this.perSecond = perSecond;
    this.windowStart = Date.now();
    this.count = 0;
  }

  async take() {
    if (!this.perSecond) return;
    this.count++;
    if (this.count >= this.perSecond) {
      const wait = 1000 - (Date.now() - this.windowStart);
      if (wait > 0) await sleep(wait);
      this.windowStart = Date.now();
      this.count = 0;
    }
  }
}

async function raidOne(index, rotation, options, shouldStop, totals, gate) {
  const account = Store.read(accountPath(index), {});
  if (!account.passToken || (!account.hi && !account.lo)) return {index, error: 'нет аккаунта'};
  const client = new Client({
    root: ROOT, account: `accounts/bot-${index}.json`, name: account.name,
    reconnect: true, index, proxyPoolFile: POOL_FILE
  });
  client.on('warning', () => {});
  const report = {index, clubs: 0, messages: 0, errors: []};
  try {
    await client.connect();
  } catch (error) {
    return {...report, error: error.message};
  }
  try {
    while (!shouldStop() && !stopping.value) {
      const club = rotation.next();
      if (!club) {await sleep(400); continue;}
      try {
        await Actions.execute(client, 'join-club', {clubTag: club.tag, timeout: 20000});
      } catch (error) {
        report.errors.push(`${club.tag}: вход — ${error.message}`);
        continue;
      }
      const deadline = Date.now() + options.spamWindowMs;
      let sent = 0;
      if (options.silent) {
        // enter and leave silently: proof of presence without a single message
        await sleep(Math.max(300, options.spamWindowMs));
      } else if (options.burst) {
        // Fire-and-forget: the packet goes out immediately, the server echo is
        // not awaited. Counts are attempts, not confirmations.
        while (Date.now() < deadline && !shouldStop() && !stopping.value) {
          try {
            await gate.take();
            const message = Protocol.encode('club-chat', {text: options.spamText});
            client.messaging.send(message.id, message.payload, message.version);
            sent++;
            totals.messages++;
          } catch (error) {
            report.errors.push(`${club.tag}: чат — ${error.message}`);
            break;
          }
          if (options.burstDelay > 0) await sleep(options.burstDelay);
        }
      } else {
        while (Date.now() < deadline && !shouldStop() && !stopping.value) {
          try {
            await Actions.execute(client, 'club-chat', {text: options.spamText, timeout: 5000});
            sent++;
            totals.messages++;
          } catch (error) {
            report.errors.push(`${club.tag}: чат — ${error.message}`);
            break;
          }
        }
      }
      report.messages += sent;
      report.clubs++;
      totals.joined++;
      const entry = totals.clubs[club.tag] ||= {tag: club.tag, name: club.name, visits: 0, messages: 0};
      entry.visits++;
      entry.messages += sent;
      try {
        await Actions.execute(client, 'leave-club', {timeout: 15000});
      } catch (error) {
        report.errors.push(`${club.tag}: выход — ${error.message}`);
      }
    }
  } finally {
    try {client.close();} catch {}
  }
  return report;
}

async function raidBulk(indexes, options) {
  const {list} = loadPool();
  if (!list.length) throw new Error('Пул пуст');
  const rotation = new Rotation();
  const deadline = options.minutes > 0 ? Date.now() + options.minutes * 60000 : Infinity;
  const shouldStop = () => Date.now() >= deadline;

  const state = loadState();
  const totals = {messages: 0, joined: 0, clubs: {}};
  const stopAll = () => false;
  const {client: scout, loop} = await startScout(options, rotation, shouldStop).catch(error => {
    throw new Error(`разведчик не поднялся: ${error.message}`);
  });
  log('raid', `ротация каждые ${options.refreshMs} мс, окно спама ${options.spamWindowMs} мс, клубов в цикле ${options.allClubs ? 'все' : options.clubLimit}`);

  let cursor = 0;
  const workers = indexes.filter(index => {
    const account = Store.read(accountPath(index), {});
    return account.passToken && (account.hi || account.lo);
  });
  log('raid', `аккаунтов ${workers.length}, поток ${options.concurrency}, предел ${options.minutes ? options.minutes + ' мин' : 'до остановки'}`);

  const gate = new RateGate(options.maxRate);
  let active = 0;
  // joined/clubs в totals остаются как есть; панели нужны плоские active/covered/total.
  const stats = startStats('raid', totals, () => ({
    active,
    covered: Object.keys(totals.clubs).length,
    total: rotation.size
  }));
  const worker = async () => {
    while (!shouldStop() && !stopping.value && cursor < workers.length) {
      const index = workers[cursor++];
      active++;
      const report = await raidOne(index, rotation, options, shouldStop, totals, gate);
      active--;
      state.accounts[index] = {at: new Date().toISOString(), ...report};
      Store.write(STATE_FILE, state);
      log('raid', `${index}: клубов ${report.clubs}, сообщений ${report.messages}, ошибок ${report.errors.length}${report.error ? ` — ${report.error}` : ''}`);
    }
  };

  const reporter = setInterval(() => {
    const covered = Object.keys(totals.clubs).length;
    log('raid', `живых ${active}, клубов затронуто ${covered} из ${rotation.size}, сообщений ${totals.messages}`);
    state.totals = {at: new Date().toISOString(), ...totals};
    Store.write(STATE_FILE, state);
  }, 15000);

  try {
    await Promise.all(Array.from({length: options.concurrency}, worker));
  } finally {
    clearInterval(reporter);
    stats.stop();
  }
  await sleep(100);
  try {scout.close();} catch {}
  log('raid', `итого: сообщений ${totals.messages}, входов ${totals.joined}, клубов затронуто ${Object.keys(totals.clubs).length}`);
  state.totals = {at: new Date().toISOString(), ...totals};
  Store.write(STATE_FILE, state);
}

// --- cli ------------------------------------------------------------------
// A crashed run leaves .lock files behind. The next acquire would clear them,
// but a recycled pid can make a dead lock look alive, so sweep at startup.
function cleanStaleLocks() {
  let removed = 0;
  try {
    for (const file of fs.readdirSync(ACCOUNTS)) {
      if (!file.endsWith('.json.lock')) continue;
      const full = path.join(ACCOUNTS, file);
      const holder = Store.read(full, {});
      const pid = Number(holder.pid);
      if (Number.isInteger(pid) && pid > 0) {
        let alive = false;
        try {process.kill(pid, 0); alive = true;} catch (error) {if (error.code !== 'ESRCH') continue;}
        // pid переиспользован другим процессом — проверяем, что это вообще node,
        // иначе мёртвая блокировка выглядит живой и держит аккаунт.
        if (alive) {
          let node = false;
          try {node = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('node');} catch {node = true;}
          if (node) continue;
        }
      }
      try {fs.unlinkSync(full); removed++;} catch {}
    }
  } catch {}
  if (removed) log('locks', `снял зависшие блокировки: ${removed}`);
}

// Общий парсер знает только свой список булевых флагов, а эти движок объявляет
// в help. Голый флаг превращаем в =1, иначе parse() требует значение и падает.
const FLAG_ONLY = new Set(['hold', 'silent', 'direct', 'verbose', 'all-clubs', 'members-only', 'random-names']);
function normalizeArgv(argv) {
  return argv.map((item, i) => {
    if (!item.startsWith('--')) return item;
    if (!FLAG_ONLY.has(item.slice(2))) return item;
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) return item;
    return item + '=1';
  });
}

async function main() {
  cleanStaleLocks();
  const {options, positional} = parse(normalizeArgv(process.argv.slice(2)));
  const command = positional[0] || 'help';
  const settings = {
    first: Number(options.first ?? 1),
    count: Number(options.count ?? 100),
    name: options.name ?? 't.me/Unterfied',
    randomNames: !!options.randomNames,
    text: options.text !== undefined ? String(options.text) : null,
    spamText: options.text !== undefined ? String(options.text) : 'ишак получил $win',
    concurrency: Number(options.concurrency ?? 8),
    poolLimit: Number(options.poolLimit ?? 100),
    poolCandidates: Number(options.poolCandidates ?? 600),
    poolParallel: Number(options.poolParallel ?? 24),
    proxyTimeout: Number(options.proxyTimeout ?? 7000),
    proxyList: options.proxyList ? String(options.proxyList) : null,
    proxyUrl: options.proxyUrl ? String(options.proxyUrl) : null,
    registerAttempts: Number(options.registerAttempts ?? 6),
    accounts: options.accounts ? String(options.accounts) : null,
    silent: !!options.silent,
    clubLimit: Number(options.clubLimit ?? 50),
    spamWindowMs: Number(options.spamWindow ?? 2000),
    burst: !options.waitEcho,
    burstDelay: Number(options.burstDelay ?? 50),
    maxRate: Number(options.maxRate ?? 120),
    // --refresh is a boolean flag in the shared parser, so the interval needs its own key.
    refreshMs: Number(options.refreshMs ?? 5000),
    minutes: Number(options.minutes ?? 0),
    bots: Number(options.bots ?? 0),
    membersOnly: !!options.membersOnly,
    hold: !!options.hold,
    // cycle — выходить после каждого цикла сообщений (по умолчанию);
    // end — сидеть в клубе весь прогон и выйти только в конце;
    // never — не выходить вообще, членство остаётся после атаки.
    exitMode: ['cycle', 'end', 'never'].includes(String(options.exitMode))
      ? String(options.exitMode)
      : (options.hold ? 'end' : 'cycle'),
    joinParallel: Number(options.joinParallel ?? 8),
    watchTimeout: Number(options.watchTimeout ?? 60000),
    messageCycle: Number(options.messageCycle ?? 10),
    cycleDelay: Number(options.cycleDelay ?? 400),
    club: options.club ? String(options.club) : null,
    code: options.code ? String(options.code) : null,
    tag: options.tag ? String(options.tag) : null,
    region: options.region ? String(options.region).toUpperCase() : null,
    regionAttempts: Number(options.regionAttempts ?? 3),
    direct: !!options.direct,
    control: options.control ? String(options.control) : null,
    // Без флага статистика только в stdout; с ним — живой JSON на диске.
    statsFile: options.statsFile ? path.resolve(String(options.statsFile)) : null,
    verbose: !!options.verbose,
    allClubs: !!options.allClubs
  };
  statsPath = settings.statsFile;
  if (statsPath) {
    try {fs.mkdirSync(path.dirname(statsPath), {recursive: true});} catch {}
  }
  fs.mkdirSync(RUNTIME, {recursive: true});
  fs.mkdirSync(ACCOUNTS, {recursive: true});
  global.Debugger = {info: () => {}, warn: () => {}, error: () => {}};

  if (command === 'help') {
    console.log([
      'club-rush — пул прокси, массовая регистрация, набег на клубы',
      '',
      '  node tools/club-rush.js pool     [--pool-limit 100]',
      '  node tools/club-rush.js register [--count 100] [--concurrency 8]',
      '  node tools/club-rush.js attack   --club "#TAG" [--bots 30] [--minutes 10] [--max-rate 40] [--burst-delay 250]',
      '  node tools/club-rush.js raid     [--club-limit 50] [--refresh-ms 5000] [--spam-window 2000] [--burst-delay 50] [--minutes 30]',
      '  node tools/club-rush.js all      [все три шага подряд]',
      '',
      'Набег: разведчик обновляет список открытых клубов каждые --refresh мс,',
      'воркеры берут клубы из общей ротации, спамят --spam-window мс и выходят.',
      '--all-clubs — весь список, иначе первые --club-limit позиций.'
    ].join('\n'));
    return;
  }

  const indexes = settings.accounts
    ? settings.accounts.split(',').map(v => Number(v.trim())).filter(n => Number.isInteger(n) && n > 0)
    : Array.from({length: settings.count}, (_, n) => settings.first + n);

  if (command === 'pool') {await buildPool(settings); return;}
  if (command === 'register') {await registerBulk(indexes, settings); return;}
  if (command === 'region') {
    if (!settings.region) throw new Error('Укажите --region, например --region KZ');
    await setRegionBulk(indexes, settings); return;
  }
  if (command === 'attack') {await attackClub(settings, indexes); return;}
  if (command === 'invite') {await inviteBulk(settings, indexes); return;}
  if (command === 'occupy') {await occupyClub(settings, indexes); return;}
  if (command === 'watch') {await watchTarget(settings, indexes); return;}
  if (command === 'lobby') {await lobbyRush(settings, indexes); return;}
  if (command === 'requests') {await requestSpam(settings, indexes); return;}
  if (command === 'friends') {await friendSpam(settings, indexes); return;}
  if (command === 'clubs') {await listClubs(settings, indexes); return;}
  if (command === 'check') {console.log(JSON.stringify(await checkClub({club: options.club, direct: options.direct}))); return;}
  if (command === 'raid') {await raidBulk(indexes, settings); return;}
  if (command === 'all') {
    await buildPool(settings);
    await registerBulk(indexes, settings);
    await raidBulk(indexes, settings);
    return;
  }
  throw new Error(`Неизвестная команда ${command}; см. help`);
}

if (require.main === module) {
  main().catch(error => {console.error(error.message); process.exitCode = 1;});
}

module.exports = {checkClub, attackClub, lobbyRush, requestSpam, friendSpam, listClubs, occupyClub, watchTarget, registerBulk, setRegionBulk, buildPool, loadPool};