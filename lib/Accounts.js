const fs = require('node:fs');
const path = require('node:path');
const Store = require('./Store');
const TagCodec = require('../utils/TagCodec');
const { AppError, codes, codeOf, fromFilesystem } = require('./Errors');

// Реестр — производный индекс поверх accounts/*.json. Источник истины — сами файлы,
// поэтому index.json можно удалить и пересобрать в любой момент.
const VERSION = 1;
const REGISTRY_MAX_AGE = 60000;
const REGISTRY_WRITE_INTERVAL = 5000;
const ACCOUNTS_DIR = 'accounts';
const RESULT_FILE = /^[a-f0-9-]+\.json$/;
const TEMP_OR_LOCK = /(\.tmp-\d+|\.lock)$/;

const pendingWrites = new Map();
let warned = false;

function accountsDir(root) {
  return path.join(root, ACCOUNTS_DIR);
}

function registryPath(root) {
  return path.join(accountsDir(root), 'index.json');
}

// bot-N.json → N; любой другой *.json — null (файл всё равно попадает в скан).
function indexOfName(name) {
  const match = /^bot-(\d+)\.json$/.exec(name);
  return match ? Number(match[1]) : null;
}

function tagOf(hi, lo) {
  if (!Number.isFinite(hi) || !Number.isFinite(lo)) return null;
  if (!hi && !lo) return null;
  try {
    return TagCodec.logicLongToTag(hi, lo);
  } catch {
    return null;
  }
}

// В account.json club/team могут быть как строкой тега, так и разобранным объектом.
function tagValue(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && typeof value.tag === 'string') return value.tag;
  return null;
}

function blankEntry(name, index, stat) {
  return {
    file: name,
    index,
    hi: null,
    lo: null,
    tag: null,
    name: null,
    club: null,
    team: null,
    hasToken: false,
    bindToken: false,
    updatedAt: stat ? new Date(stat.mtimeMs).toISOString() : new Date().toISOString(),
    size: stat ? stat.size : 0,
  };
}

function fillEntry(entry, account) {
  const hi = Number(account.hi);
  const lo = Number(account.lo);
  entry.hi = Number.isFinite(hi) ? hi : null;
  entry.lo = Number.isFinite(lo) ? lo : null;
  entry.tag = tagOf(entry.hi, entry.lo);
  entry.name = typeof account.name === 'string' && account.name ? account.name : null;
  entry.club = tagValue(account.club);
  entry.team = account.team ?? null;
  entry.hasToken = !!account.passToken;
  entry.bindToken = !!account.bindToken;
  return entry;
}

function compareEntries(a, b) {
  const ai = a.index ?? Number.MAX_SAFE_INTEGER;
  const bi = b.index ?? Number.MAX_SAFE_INTEGER;
  if (ai !== bi) return ai - bi;
  return a.file < b.file ? -1 : a.file > b.file ? 1 : 0;
}

function countAccountFiles(root) {
  try {
    return fs.readdirSync(accountsDir(root)).filter((name) => name.endsWith('.json') && name !== 'index.json').length;
  } catch {
    return 0;
  }
}

// Полный скан каталога аккаунтов; битый JSON не прерывает обход.
function scan(root) {
  let names;
  try {
    names = fs.readdirSync(accountsDir(root)).sort();
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw fromFilesystem(error, { dir: accountsDir(root), operation: 'readdir' });
  }
  const entries = [];
  for (const name of names) {
    if (!name.endsWith('.json') || name === 'index.json') continue;
    const file = path.join(accountsDir(root), name);
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    const entry = blankEntry(name, indexOfName(name), stat);
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (error) {
      entry.error = error.message;
      entry.errorCode = fromFilesystem(error, { file }).code;
      entries.push(entry);
      continue;
    }
    let account;
    try {
      account = JSON.parse(text);
    } catch (error) {
      entry.error = `Повреждён JSON: ${error.message}`;
      entry.errorCode = codes.STORE_CORRUPT;
      entries.push(entry);
      continue;
    }
    if (!account || typeof account !== 'object' || Array.isArray(account)) {
      entry.error = 'Ожидался JSON-объект';
      entry.errorCode = codes.STORE_CORRUPT;
      entries.push(entry);
      continue;
    }
    entries.push(fillEntry(entry, account));
  }
  return entries.sort(compareEntries);
}

function isStale(root, registry) {
  const stamp = Date.parse(registry.updatedAt || '');
  if (!Number.isFinite(stamp) || Date.now() - stamp > REGISTRY_MAX_AGE) return true;
  return countAccountFiles(root) !== registry.accounts.length;
}

// Полная пересборка индекса через Store.write (атомарный rename, режим 0600).
// Ошибки записи индекса — FILESYSTEM_ERROR/PERMISSION_DENIED, message исходный.
function refresh(root) {
  const registry = { version: VERSION, updatedAt: new Date().toISOString(), accounts: scan(root) };
  const file = registryPath(root);
  try {
    Store.write(file, registry);
  } catch (error) {
    if (error instanceof AppError && error.kind === 'filesystem') throw error;
    throw AppError.wrap(error, codes.FILESYSTEM_ERROR, { details: { file, operation: 'write' } });
  }
  // Полная пересборка делает закэшированную базу недействительной.
  const state = pendingWrites.get(root);
  if (state) state.base = null;
  return registry;
}

// Читает index.json; если он отсутствует, устарел (60 с) или разошёлся с числом файлов — пересобирает.
function read(root) {
  let registry = null;
  try {
    registry = Store.read(registryPath(root), null);
  } catch {
    registry = null;
  }
  if (
    registry &&
    registry.version === VERSION &&
    Array.isArray(registry.accounts) &&
    registry.accounts.every((entry) => entry && typeof entry.file === 'string')
  ) {
    if (!isStale(root, registry)) return registry;
  }
  return refresh(root);
}

// Поиск по индексу, тегу (#ABC или ABC), точному нику, имени файла или номеру.
function find(root, query) {
  const text = String(query ?? '').trim();
  if (!text) return null;
  const registry = read(root);
  const accounts = registry.accounts;
  if (/^\d+$/.test(text)) {
    const index = Number(text);
    const byIndex = accounts.find((entry) => entry.index === index);
    if (byIndex) return byIndex;
  }
  const bot = /^bot-(\d+)(?:\.json)?$/i.exec(text);
  if (bot) {
    const index = Number(bot[1]);
    const byIndex = accounts.find((entry) => entry.index === index);
    if (byIndex) return byIndex;
  }
  const tag = text.toUpperCase().replace(/^#/, '');
  if (tag) {
    const byTag = accounts.find((entry) => entry.tag === `#${tag}`);
    if (byTag) return byTag;
  }
  return accounts.find((entry) => entry.name === text) || accounts.find((entry) => entry.file === text) || null;
}

function notify(error) {
  if (warned) return;
  warned = true;
  try {
    global.Debugger?.warn?.(`реестр аккаунтов: ${error.message}`);
  } catch {}
}

function flushPending(root, state) {
  if (!state.entries.size) return;
  try {
    // База — уже прочитанный индекс (или один скан, если индекса нет). Полного скана
    // accounts/*.json на каждый upsert нет: точечные изменения ложатся поверх памяти.
    const base = loadBase(root, state);
    for (const entry of state.entries.values()) base.set(entry.file, entry);
    const accounts = [...base.values()].sort(compareEntries);
    Store.write(registryPath(root), { version: VERSION, updatedAt: new Date().toISOString(), accounts });
    // Чистим только после успешной записи: при ошибке изменения остаются для повтора.
    state.entries.clear();
  } catch (error) {
    notify(error);
  } finally {
    state.lastWriteAt = Date.now();
  }
}

function loadBase(root, state) {
  if (state.base) return state.base;
  let registry = null;
  try {
    registry = Store.read(registryPath(root), null);
  } catch {
    registry = null;
  }
  const base = new Map();
  const usable =
    registry && registry.version === VERSION && Array.isArray(registry.accounts)
      ? registry.accounts.filter((entry) => entry && typeof entry.file === 'string')
      : null;
  if (usable) {
    for (const entry of usable) base.set(entry.file, entry);
  } else {
    // Индекса нет или он нечитаем — один полный скан при первом flush, дальше только память.
    for (const entry of scan(root)) base.set(entry.file, entry);
  }
  state.base = base;
  return base;
}

// Синхронный финальный flush: вызывается при остановке флота (SIGTERM/SIGINT).
function flush(root) {
  const state = pendingWrites.get(root);
  if (!state) return false;
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  flushPending(root, state);
  return true;
}

// Точечное обновление записи после входа/смены ника. Запись реестра — не чаще раза в 5 с,
// отложенная запись объединяет все изменения и не держит процесс (timer.unref).
function upsert(root, account, file) {
  const name = path.basename(String(file || `bot-${account?.hi ?? 'unknown'}.json`));
  const full = path.join(accountsDir(root), name);
  let stat = null;
  try {
    stat = fs.statSync(full);
  } catch {}
  const entry = fillEntry(blankEntry(name, indexOfName(name), stat), account || {});
  let state = pendingWrites.get(root);
  if (!state) {
    state = { entries: new Map(), timer: null, lastWriteAt: 0, base: null };
    pendingWrites.set(root, state);
  }
  state.entries.set(entry.file, entry);
  const wait = REGISTRY_WRITE_INTERVAL - (Date.now() - state.lastWriteAt);
  if (wait <= 0) flushPending(root, state);
  else if (!state.timer) {
    state.timer = setTimeout(() => {
      state.timer = null;
      flushPending(root, state);
    }, wait);
    state.timer.unref?.();
  }
  return entry;
}

function reportRemoval(report, dir, name, reason, dryRun) {
  const file = path.join(dir, name);
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {}
  if (!dryRun) {
    try {
      fs.unlinkSync(file);
    } catch (error) {
      report.errors.push({ file: name, error: error.message, code: fromFilesystem(error, { file }).code });
      return false;
    }
  }
  report.removed.push({ file: name, reason, size });
  return true;
}

// Удаляет пустые аккаунты (нет passToken/bindToken и hi/lo) и осиротевшие .lock/.tmp-*.
// Файл с passToken не удаляется никогда. dryRun только строит отчёт.
function prune(root, options = {}) {
  const dryRun = !!options.dryRun;
  const dir = accountsDir(root);
  const report = { dryRun, removed: [], skipped: [], errors: [] };
  const removedBases = new Set();
  if (!fs.existsSync(dir)) return report;
  for (const entry of scan(root)) {
    if (entry.error) {
      report.skipped.push({ file: entry.file, reason: 'unreadable', code: entry.errorCode || codes.STATE_ERROR });
      continue;
    }
    let account;
    try {
      account = Store.read(path.join(dir, entry.file), {});
    } catch (error) {
      report.skipped.push({ file: entry.file, reason: 'unreadable', code: codeOf(error) });
      continue;
    }
    // Файл с токеном — отказ: prune его не трогает ни в каком режиме.
    if (account.passToken) {
      report.skipped.push({ file: entry.file, reason: 'pass-token', code: codes.STATE_ERROR });
      continue;
    }
    if (account.bindToken) {
      report.skipped.push({ file: entry.file, reason: 'bind-token', code: codes.STATE_ERROR });
      continue;
    }
    if (account.hi || account.lo) {
      report.skipped.push({ file: entry.file, reason: 'has-id' });
      continue;
    }
    removedBases.add(entry.file);
    reportRemoval(report, dir, entry.file, 'empty', dryRun);
  }
  for (const name of fs.readdirSync(dir)) {
    if (name === 'index.json') continue;
    const match = /^(.+)\.lock$/.exec(name) || /^(.+)\.tmp-\d+$/.exec(name);
    if (!match) continue;
    const base = match[1];
    const orphan = removedBases.has(base) || !fs.existsSync(path.join(dir, base));
    if (!orphan) {
      report.skipped.push({ file: name, reason: 'in-use', code: codes.STATE_ERROR });
      continue;
    }
    reportRemoval(report, dir, name, 'orphan', dryRun);
  }
  return report;
}

function stats(root) {
  const accounts = scan(root);
  return {
    total: accounts.length,
    withToken: accounts.filter((entry) => entry.hasToken).length,
    withClub: accounts.filter((entry) => !!entry.club).length,
    broken: accounts.filter((entry) => !!entry.error).length,
  };
}

function walk(dir, depth = 0) {
  if (depth > 4) return [];
  let items;
  try {
    items = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs = [dir];
  for (const item of items) if (item.isDirectory()) dirs.push(...walk(path.join(dir, item.name), depth + 1));
  return dirs;
}

// Удаляет из каталога файлы по маске старше maxAge; возвращает список имён.
function removeStale(dir, options = {}) {
  const pattern = options.pattern || TEMP_OR_LOCK;
  const maxAge = Number(options.maxAge ?? 0);
  const now = Number(options.now ?? Date.now());
  const removed = [];
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return removed;
  }
  for (const name of names) {
    if (!pattern.test(name)) continue;
    const file = path.join(dir, name);
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    if (!stat.isFile() || now - stat.mtimeMs <= maxAge) continue;
    try {
      fs.unlinkSync(file);
      removed.push(name);
    } catch {}
  }
  return removed;
}

// Чистка .runtime: результаты старше часа, зависшие .processing, .tmp-*/.lock старше суток.
// Аккаунты и файлы состояния (config.json, working-proxies.json, client-license.bin) не трогаются:
// вне .runtime они просто не сканируются.
function cleanup(root, options = {}) {
  const now = Number(options.now ?? Date.now());
  const resultsMaxAge = Number(options.resultsMaxAge ?? 3600000);
  const processingMaxAge = Number(options.processingMaxAge ?? 600000);
  const staleMaxAge = Number(options.staleMaxAge ?? 86400000);
  const runtime = path.join(root, '.runtime');
  const report = { results: [], processing: [], stale: [], removed: 0 };
  report.results = removeStale(path.join(runtime, 'results'), { pattern: RESULT_FILE, maxAge: resultsMaxAge, now });
  report.processing = removeStale(path.join(runtime, 'commands'), {
    pattern: /\.processing$/,
    maxAge: processingMaxAge,
    now,
  });
  for (const dir of walk(runtime)) {
    report.stale.push(...removeStale(dir, { pattern: TEMP_OR_LOCK, maxAge: staleMaxAge, now }));
  }
  report.removed = report.results.length + report.processing.length + report.stale.length;
  return report;
}

module.exports = {
  VERSION,
  scan,
  registryPath,
  refresh,
  read,
  find,
  upsert,
  flush,
  prune,
  stats,
  cleanup,
  removeStale,
  accountsDir,
};
