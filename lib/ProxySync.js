'use strict';
// Сбор и проверка пула прокси. Вынесено из tools/club-rush.js, чтобы
// tools/proxy-sync.js и club-rush pool проверяли прокси одинаково:
// ClientHello -> ServerHello через прокси.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

const Store = require('./Store');
const Sources = require('./ProxySources');
const { parseProxy, connectSocket } = require('../utils/ProxyConnect');

const ROOT = path.resolve(__dirname, '..');
const GAME_CONFIG = { ...Store.read(path.join(ROOT, 'config.json')), clientLicensePath: 'client-license.bin' };

const MAX_CANDIDATES = 3000;
const MAX_VALID = 2000;
const BUDGET_MS = 10 * 60 * 1000;
const SOURCE_TIMEOUT_MS = 15000;
const POOL_JSON = 'working-proxies.json';
const POOL_TXT = 'working-proxies.txt';
const CANDIDATE_JSON = 'proxy-candidates.json';
const CANDIDATE_TXT = 'proxy-candidates.txt';

const MSG = 'ClientHello/ServerHello through proxy';

function homePath(value, fallback) {
  const text = value === undefined || value === null || value === '' ? fallback : String(value);
  if (text === '~') return os.homedir();
  if (text.startsWith('~/')) return path.join(os.homedir(), text.slice(2));
  return path.resolve(text);
}

function poolRoot(root) {
  return homePath(root, Sources.DEFAULT_ROOT);
}

// --- проверка ---------------------------------------------------------------
// Лицензия и ModernClientHelloMessage тяжёлые: поднимаются один раз на процесс.
let helloFactory = null;
function helloMessage() {
  if (!helloFactory) {
    require('../utils/NullsLicense').apply(GAME_CONFIG, ROOT);
    const Hello = require('../Messaging/Messages/Client/ModernClientHelloMessage');
    helloFactory = () => new Hello(GAME_CONFIG);
  }
  return helloFactory();
}

// true — прокси принял CONNECT и вернул ServerHello нужного формата.
function checkProxy(url, timeout = 7000) {
  return new Promise((resolve) => {
    let proxy;
    try {
      proxy = parseProxy(url);
    } catch {
      return resolve(false);
    }
    const socket = new net.Socket();
    let done = false;
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => finish(false), timeout);
    function finish(ok) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    }
    socket.on('error', () => finish(false));
    socket.on('close', () => finish(false));
    connectSocket(socket, { host: GAME_CONFIG.host, port: GAME_CONFIG.port, proxy }, () => {
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length > 65536) return finish(false);
        if (buffer.length < 7) return;
        const length = buffer.readUIntBE(2, 3);
        if (buffer.length < length + 7) return;
        finish(buffer.readUInt16BE(0) === GAME_CONFIG.packetIds.serverHello && length >= 28);
      });
      let message;
      try {
        message = helloMessage();
        message.encode();
      } catch {
        return finish(false);
      }
      const body = message.ByteStream.getBytes();
      const head = Buffer.alloc(7);
      head.writeUInt16BE(GAME_CONFIG.packetIds.clientHello);
      head.writeUIntBE(body.length, 2, 3);
      socket.write(Buffer.concat([head, body]));
    });
  });
}

// --- сбор кандидатов --------------------------------------------------------
function listFiles(target) {
  const stat = (() => {
    try {
      return fs.statSync(target);
    } catch {
      return null;
    }
  })();
  if (!stat) throw new Error(`--list: ${target} не найден`);
  if (stat.isFile()) return [target];
  if (!stat.isDirectory()) return [];
  return fs
    .readdirSync(target, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(txt|list|csv|json)$/i.test(entry.name))
    .map((entry) => path.join(target, entry.name));
}

function readListFile(file, protocol = 'socks5') {
  const text = fs.readFileSync(file, 'utf8');
  return Sources.parseText(text, protocol, { allowPrivate: true, auth: true });
}

// Скачивание пачкой: восемь источников одновременно, ответ каждого ограничен
// 256 КБ в Sources.download, поэтому память не разъезжается.
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, Math.max(1, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function fetchSource(source, options, parseOptions) {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), options.sourceTimeout || SOURCE_TIMEOUT_MS);
  try {
    const data = await Sources.download(source, controller.signal);
    return Sources.parseText(data.text, source.protocol || 'socks5', parseOptions);
  } finally {
    clearTimeout(deadline);
  }
}

// Кандидаты собираются блоками: конфиг (с allowPrivate/auth), локальная ферма,
// публичные списки, затем пользовательские файлы. Итоговая выборка идёт
// round-robin по блокам (Sources.select), чтобы один огромный список не съел
// весь бюджет и пул оставался разнообразным.
async function gather(options = {}) {
  const limit = Math.min(MAX_CANDIDATES, Number.isFinite(options.candidates) ? Math.max(1, options.candidates) : MAX_CANDIDATES);
  const concurrency = Math.min(16, Math.max(1, Number.isInteger(options.concurrency) ? options.concurrency : 8));
  const stats = new Map();
  const groups = [];

  const slot = (name, protocol) => {
    if (!stats.has(name)) stats.set(name, { name, protocol, candidates: 0, picked: 0, valid: 0, error: null });
    return stats.get(name);
  };
  const addGroup = (name, protocol, list) => {
    const entry = slot(name, protocol);
    entry.candidates = list.length;
    if (list.length) groups.push({ name, protocol, list });
  };
  const fail = (name, protocol, error) => {
    slot(name, protocol).error = error && error.message ? error.message : String(error);
  };

  let config = [];
  try {
    config = Sources.loadConfig(options.root);
  } catch (error) {
    fail('config', 'socks5', error);
  }

  const remote = config.filter((source) => source.url);
  await mapLimit(remote, concurrency, async (source) => {
    try {
      const list = await fetchSource(source, options, { allowPrivate: source.allowPrivate, auth: source.auth || true });
      addGroup(source.name, source.protocol, list);
    } catch (error) {
      fail(source.name, source.protocol, error);
    }
  });

  const localProto = config.find((entry) => entry.host && entry.ports)?.protocol || 'socks5';
  const local = Sources.collectLocal({
    config,
    maxPorts: Math.min(limit, Number.isFinite(options.maxLocal) ? options.maxLocal : 4096),
  });
  if (local.length) addGroup('local-farm', localProto, local);

  for (const target of Array.isArray(options.list) ? options.list : []) {
    let files;
    try {
      files = listFiles(target);
    } catch (error) {
      fail(`list:${path.basename(String(target))}`, 'socks5', error);
      continue;
    }
    for (const file of files) {
      try {
        addGroup(`list:${path.basename(file)}`, 'socks5', readListFile(file));
      } catch (error) {
        fail(`list:${path.basename(file)}`, 'socks5', error);
      }
    }
  }

  const inbox = homePath(options.inbox, path.join(poolRoot(options.root), '.runtime', 'proxy-inbox.txt'));
  if (fs.existsSync(inbox)) {
    try {
      addGroup(`inbox:${path.basename(inbox)}`, 'socks5', readListFile(inbox));
    } catch (error) {
      fail(`inbox:${path.basename(inbox)}`, 'socks5', error);
    }
  }

  for (const url of Array.isArray(options.sourceUrl) ? options.sourceUrl : []) {
    try {
      const controller = new AbortController();
      const deadline = setTimeout(() => controller.abort(), options.sourceTimeout || SOURCE_TIMEOUT_MS);
      let response;
      try {
        response = await fetch(url, { signal: controller.signal });
      } finally {
        clearTimeout(deadline);
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      addGroup(`url:${new URL(url).host}`, 'socks5', Sources.parseText(text, 'socks5', { allowPrivate: true, auth: true }));
    } catch (error) {
      fail(`url:${url}`, 'socks5', error);
    }
  }

  if (options.builtin !== false) {
    await mapLimit(Sources.sources, concurrency, async (source) => {
      try {
        const list = await fetchSource(source, options, {});
        addGroup(source.name, source.protocol, list);
      } catch (error) {
        fail(source.name, source.protocol, error);
      }
    });
  }

  const selected = Sources.select(groups.map((group) => group.list), [], limit, options.cycle || 0);
  // Происхождение: первая группа, где встречается прокси (порядок блоков выше).
  const selectedSet = new Set(selected);
  const origins = new Map();
  for (const group of groups) {
    const entry = slot(group.name, group.protocol);
    for (const url of group.list) {
      if (origins.has(url)) continue;
      origins.set(url, group.name);
      if (selectedSet.has(url)) entry.picked++;
    }
  }
  return { candidates: selected, stats, origins, groups: groups.length, truncated: selected.length >= limit };
}

// --- проверка пула ----------------------------------------------------------
async function verify(options = {}) {
  const candidates = Array.isArray(options.candidates) ? options.candidates : [];
  const limit = Math.min(MAX_VALID, Number.isFinite(options.limit) ? Math.max(1, options.limit) : MAX_VALID);
  const parallel = Math.min(200, Math.max(1, Number.isInteger(options.parallel) ? options.parallel : 32));
  const timeout = Math.max(1000, Number.isFinite(options.timeout) ? options.timeout : 8000);
  const budget = Math.max(5000, Number.isFinite(options.budgetMs) ? options.budgetMs : BUDGET_MS);
  const startedAt = Date.now();
  const valid = [];
  let cursor = 0;
  let checked = 0;
  const progress = typeof options.onProgress === 'function' ? options.onProgress : null;

  const worker = async () => {
    while (cursor < candidates.length && valid.length < limit) {
      if (Date.now() - startedAt > budget) return;
      const url = candidates[cursor++];
      const ok = await checkProxy(url, timeout);
      checked++;
      if (ok && valid.length < limit) valid.push(url);
      if (progress && checked % 50 === 0) progress({ checked, valid: valid.length, total: candidates.length });
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallel, Math.max(1, candidates.length)) }, worker));
  return { valid, checked, elapsed: Date.now() - startedAt, budgetExceeded: Date.now() - startedAt > budget };
}

function mergeStats(stats, origins, valid) {
  const counted = new Map();
  for (const url of valid) {
    const name = origins.get(url);
    if (!name) continue;
    counted.set(name, (counted.get(name) || 0) + 1);
  }
  const out = {};
  for (const [name, entry] of stats) out[name] = { ...entry, valid: counted.get(name) || 0 };
  return out;
}

// --- файлы ------------------------------------------------------------------
function atomicWrite(file, body, mode = 0o600) {
  const temporary = `${file}.tmp-${process.pid}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(temporary, body, { mode });
    fs.renameSync(temporary, file);
  } catch (error) {
    try {
      fs.unlinkSync(temporary);
    } catch {}
    throw error;
  }
}

function textBody(list) {
  return list.length ? list.join('\n') + '\n' : '';
}

function readPool(root) {
  const dir = poolRoot(root);
  const file = path.join(dir, POOL_JSON);
  if (!fs.existsSync(file)) return { list: [], meta: {}, dir, file };
  const data = Store.read(file, { proxies: [] });
  const list = Array.isArray(data) ? data : data.proxies;
  return { list: Array.isArray(list) ? list.filter((item) => typeof item === 'string') : [], meta: Array.isArray(data) ? {} : data, dir, file };
}

function writePool(root, { proxies, checked, stats, checkedAt }) {
  const dir = poolRoot(root);
  const file = path.join(dir, POOL_JSON);
  const payload = {
    checkedAt: checkedAt || new Date().toISOString(),
    checked: Number(checked) || 0,
    valid: proxies.length,
    verification: MSG,
    stats: stats || {},
    proxies,
  };
  Store.write(file, payload);
  atomicWrite(path.join(dir, POOL_TXT), textBody(proxies));
  return file;
}

function writeCandidates(root, { candidates, stats, checkedAt }) {
  const dir = poolRoot(root);
  const file = path.join(dir, CANDIDATE_JSON);
  const payload = {
    checkedAt: checkedAt || new Date().toISOString(),
    checked: 0,
    valid: 0,
    verification: 'candidates only (--no-check)',
    stats: stats || {},
    proxies: candidates,
  };
  Store.write(file, payload);
  atomicWrite(path.join(dir, CANDIDATE_TXT), textBody(candidates));
  return file;
}

module.exports = {
  checkProxy,
  gather,
  verify,
  mergeStats,
  readPool,
  writePool,
  writeCandidates,
  readListFile,
  poolRoot,
  atomicWrite,
  MAX_CANDIDATES,
  MAX_VALID,
  BUDGET_MS,
  MSG,
  POOL_JSON,
  POOL_TXT,
  CANDIDATE_JSON,
  CANDIDATE_TXT,
};