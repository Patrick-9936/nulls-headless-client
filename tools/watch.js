#!/usr/bin/env node
'use strict';
// Живой дашборд флота без интерактива: читает fleet-status.json, fleet.log,
// реестр аккаунтов и результаты команд, перерисовывает кадр по таймеру.
const fs = require('node:fs');
const path = require('node:path');
const I18N = require('../lib/i18n');
const Args = require('../lib/Args');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_INTERVAL = 1000;
const DEFAULT_LOG_LINES = 8;
const MIN_INTERVAL = 100;
const MIN_WIDTH = 40;
const LOG_TAIL_BYTES = 256 * 1024;
// Пересборка списка результатов команд не чаще раза в 2.5 с: в живом цикле это блокирующий I/O.
const COMMAND_REFRESH_INTERVAL = 2500;
const RESULT_FILES_LIMIT = 20;
const ANSI = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  cyan: '\u001b[36m',
};

// ---------------------------------------------------------------- чтение файлов

// Отсутствие файла — не ошибка: возвращаем { value: undefined }.
function readJson(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { value: undefined };
    return { error: error.message };
  }
  try {
    return { value: JSON.parse(raw) };
  } catch (error) {
    return { error: error.message };
  }
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

// fleet.pid + проверка, что процесс жив и это именно fleet.js (когда есть /proc).
function fleetProcess(root) {
  const file = path.join(root, 'fleet.pid');
  const { value, error } = readJson(file);
  if (error) return { running: false, pid: null };
  const pid = positiveInteger(typeof value === 'number' ? value : String(value ?? '').trim());
  if (!pid) return { running: false, pid: null };
  try {
    process.kill(pid, 0);
  } catch {
    return { running: false, pid };
  }
  try {
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`);
    if (!cmdline.includes(Buffer.from('fleet.js'))) return { running: false, pid };
  } catch {
    // /proc недоступен (Windows, Termux-песочница) — доверяем kill(0).
  }
  return { running: true, pid };
}

// Хвост файла без чтения целиком: последние bytes, затем последние lines строк.
function tailLines(file, lines, bytes = LOG_TAIL_BYTES) {
  let handle;
  try {
    const stat = fs.statSync(file);
    handle = fs.openSync(file, 'r');
    const start = Math.max(0, stat.size - bytes);
    const length = stat.size - start;
    const buffer = Buffer.alloc(length);
    if (length > 0) fs.readSync(handle, buffer, 0, length, start);
    const text = buffer.toString('utf8').replace(/\u001b\[[0-9;]*m/g, '');
    const all = text.split(/\r?\n/);
    if (all.length && all[all.length - 1] === '') all.pop();
    return all.slice(-lines);
  } catch {
    return [];
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
}

// Реестр аккаунтов пишет другой агент; формат не фиксирован — читаем осторожно.
function accountRegistry(root) {
  const file = path.join(root, 'accounts', 'index.json');
  const { value, error } = readJson(file);
  if (error) return { present: true, error, count: null, entries: [] };
  if (value === undefined) return { present: false, count: null, entries: [] };
  const list = Array.isArray(value) ? value : Array.isArray(value.accounts) ? value.accounts : null;
  if (list) return { present: true, count: list.length, entries: list };
  if (value && typeof value === 'object') {
    const nested = Object.values(value).filter((item) => item && typeof item === 'object');
    return { present: true, count: Object.keys(value).length, entries: nested };
  }
  return { present: true, count: null, entries: [] };
}

function registryKey(entry) {
  const candidate = entry.index ?? entry.bot ?? entry.id ?? entry.slot;
  return positiveInteger(candidate);
}

// Ошибки последних команд: .runtime/results/<uuid>.json с ok:false или error внутри result.
// cache позволяет не перечитывать каталог чаще COMMAND_REFRESH_INTERVAL в живом цикле.
function commandFailures(root, limit = 5, cache = null, now = Date.now()) {
  if (cache && Array.isArray(cache.commandErrors) && now - (cache.commandErrorsAt ?? 0) < COMMAND_REFRESH_INTERVAL)
    return cache.commandErrors;
  const value = scanCommandFailures(root, limit);
  if (cache) {
    cache.commandErrors = value;
    cache.commandErrorsAt = now;
  }
  return value;
}

function scanCommandFailures(root, limit) {
  const dir = path.join(root, '.runtime', 'results');
  let names;
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  const files = [];
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      files.push({ name, file, at: fs.statSync(file).mtimeMs });
    } catch {
      /* файл исчез между readdir и stat */
    }
  }
  files.sort((a, b) => b.at - a.at);
  const failures = [];
  for (const item of files.slice(0, RESULT_FILES_LIMIT)) {
    if (failures.length >= limit) break;
    const { value } = readJson(item.file);
    if (!value || typeof value !== 'object') continue;
    let message = null;
    if (value.ok === false) message = value.error || 'ошибка без описания';
    else if (Array.isArray(value.result)) {
      const failed = value.result.find((entry) => entry && (entry.error || entry.confirmed === false));
      if (failed) message = failed.error || `confirmed: false (бот ${failed.index ?? '?'})`;
    }
    if (message) failures.push({ file: item.name, at: new Date(item.at).toISOString(), message: String(message) });
  }
  return failures;
}

// Метрики необязательны: другой агент добавляет status.metrics и/или поля ботов.
function metricsOf(status, bots) {
  const metrics = status && typeof status.metrics === 'object' && status.metrics ? status.metrics : {};
  const average = (field) => {
    const values = bots.map((bot) => Number(bot[field])).filter((value) => Number.isFinite(value) && value > 0);
    if (!values.length) return null;
    return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
  };
  const login = Number(metrics.avgLoginMs ?? metrics.loginMs);
  const rtt = Number(metrics.avgRttMs ?? metrics.rttMs);
  return {
    // 0 мс — валидное измерение (вход в ту же миллисекунду), а не «нет данных».
    loginMs: Number.isFinite(login) && login >= 0 ? Math.round(login) : average('loginMs'),
    rttMs: Number.isFinite(rtt) && rtt >= 0 ? Math.round(rtt) : average('rttMs'),
  };
}

function stateSummary(states) {
  return Object.entries(states || {})
    .filter(([, count]) => Number(count) > 0)
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .map(([state, count]) => I18N.t('watch.stateCount', { state, count }))
    .join(', ');
}

// Разбор --bots first:count; мусор игнорируется, фильтр тогда не действует.
// Принимает и уже нормализованный объект: normalizeOptions идемпотентна.
function parseBotsFilter(value) {
  if (value && typeof value === 'object') {
    const first = Number(value.first);
    const last = Number(value.last);
    if (Number.isInteger(first) && Number.isInteger(last) && first >= 1 && last >= first) return { first, last };
    return null;
  }
  if (typeof value !== 'string') return null;
  const match = /^(\d+):(\d+)$/.exec(value.trim());
  if (!match) return null;
  const first = Number(match[1]);
  const count = Number(match[2]);
  if (first < 1 || count < 1) return null;
  return { first, last: first + count - 1 };
}

function normalizeOptions(options = {}) {
  const interval = Number(options.interval);
  const logLines = Number(options.logLines);
  return {
    interval: Number.isFinite(interval) && interval >= MIN_INTERVAL ? Math.floor(interval) : DEFAULT_INTERVAL,
    logLines: Number.isFinite(logLines) && logLines >= 0 ? Math.floor(logLines) : DEFAULT_LOG_LINES,
    once: options.once === true,
    bots: parseBotsFilter(options.bots),
  };
}

// ---------------------------------------------------------------- кэш чтения

// Хвост лога перечитывается только когда меняются размер или mtime файла.
function cachedLogTail(cache, file, lines) {
  if (!cache) return tailLines(file, lines);
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    cache.log = null;
    return [];
  }
  const key = `${stat.size}:${stat.mtimeMs}:${lines}`;
  if (cache.log && cache.log.key === key) return cache.log.value;
  const value = tailLines(file, lines);
  cache.log = { key, value };
  return value;
}

// ---------------------------------------------------------------- сборка кадра

// Единственная точка нормализации опций. cache (необязательный) живёт между кадрами
// и избавляет живой цикл от повторного чтения лога и каталога результатов.
function collectFrame({ root = ROOT, options, frameOptions, now = Date.now(), width, cache = null } = {}) {
  const config = normalizeOptions(frameOptions ?? options ?? {});
  const process_ = fleetProcess(root);
  const statusFile = path.join(root, 'fleet-status.json');
  const statusResult = readJson(statusFile);
  const status = statusResult.value && typeof statusResult.value === 'object' ? statusResult.value : null;
  const registry = accountRegistry(root);
  const byIndex = new Map();
  for (const entry of registry.entries) {
    const index = registryKey(entry);
    if (index && !byIndex.has(index)) byIndex.set(index, entry);
  }
  let bots = Array.isArray(status?.bots) ? status.bots : [];
  if (config.bots) bots = bots.filter((bot) => bot.index >= config.bots.first && bot.index <= config.bots.last);
  bots = bots.map((bot) => {
    const entry = byIndex.get(bot.index) || {};
    return {
      index: bot.index ?? null,
      tag: bot.tag ?? entry.tag ?? null,
      name: bot.name ?? entry.name ?? null,
      status: bot.status ?? 'unknown',
      attempts: Number(bot.attempts ?? 0),
      error: bot.error ?? null,
      joined: bot.joined === true,
      onlineSince: bot.onlineSince ?? null,
      lastServerAt: bot.lastServerAt ?? null,
    };
  });
  const states = {};
  for (const bot of bots) states[bot.status] = (states[bot.status] || 0) + 1;
  const updatedAt = status?.updatedAt ?? null;
  const updatedMs = updatedAt ? Date.parse(updatedAt) : NaN;
  const ageMs = Number.isFinite(updatedMs) ? Math.max(0, now - updatedMs) : null;
  return {
    generatedAt: new Date(now).toISOString(),
    width: Math.max(MIN_WIDTH, Number.isFinite(Number(width)) ? Number(width) : 100),
    running: process_.running,
    pid: process_.pid,
    statusFile: { present: !!status, error: statusResult.error || null },
    updatedAt,
    ageMs,
    first: status?.first ?? null,
    requested: status?.requested ?? null,
    clubTag: status?.clubTag ?? null,
    paused: !!status?.creationPaused,
    states,
    online: bots.filter((bot) => bot.status === 'online').length,
    total: bots.length,
    metrics: metricsOf(status, bots),
    registry: { present: registry.present, count: registry.count, error: registry.error || null },
    bots,
    log: config.logLines > 0 ? cachedLogTail(cache, path.join(root, 'fleet.log'), config.logLines) : [],
    logLines: config.logLines,
    commandErrors: commandFailures(root, 5, cache, now),
  };
}

// ---------------------------------------------------------------- ширина и обрезка

// CJK и эмодзи занимают две ячейки; для таблицы хватает приблизительной оценки.
function visualWidth(text) {
  let width = 0;
  for (const char of String(text)) {
    const code = char.codePointAt(0);
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1f64f) ||
      (code >= 0x1f900 && code <= 0x1f9ff) ||
      (code >= 0x20000 && code <= 0x3fffd);
    width += wide ? 2 : 1;
  }
  return width;
}

function cut(text, max) {
  const value = String(text ?? '');
  if (max <= 0) return '';
  if (visualWidth(value) <= max) return value;
  if (max === 1) return '…';
  let result = '';
  let used = 0;
  for (const char of value) {
    const width = visualWidth(char);
    if (used + width > max - 1) break;
    result += char;
    used += width;
  }
  return result + '…';
}

// ---------------------------------------------------------------- отрисовка

function palette(useColor) {
  const paint = (code) => (text) => (useColor ? `${code}${text}${ANSI.reset}` : String(text));
  return {
    bold: paint(ANSI.bold),
    dim: paint(ANSI.dim),
    red: paint(ANSI.red),
    green: paint(ANSI.green),
    yellow: paint(ANSI.yellow),
    cyan: paint(ANSI.cyan),
  };
}

function clockOf(iso) {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(11, 19);
}

function ageLabel(ageMs) {
  if (ageMs === null) return null;
  if (ageMs < 60000) return I18N.t('watch.age.seconds', { value: Math.round(ageMs / 1000) });
  return I18N.t('watch.age.minutes', { value: Math.round(ageMs / 60000) });
}

function metricText(value) {
  return value === null || value === undefined ? I18N.t('watch.metric.empty') : I18N.t('watch.metric.ms', { value });
}

function tableLines(frame, paint) {
  const width = frame.width;
  const dash = I18N.t('watch.metric.empty');
  const nameSize = Math.min(18, Math.max(8, Math.floor(width / 5)));
  const columns = [
    { title: I18N.t('watch.column.index'), size: 4, align: 'right', value: (bot) => String(bot.index ?? dash) },
    { title: I18N.t('watch.column.tag'), size: 11, value: (bot) => bot.tag || dash },
    { title: I18N.t('watch.column.name'), size: nameSize, value: (bot) => bot.name || dash },
    { title: I18N.t('watch.column.status'), size: 12, value: (bot) => bot.status },
    { title: I18N.t('watch.column.attempts'), size: 7, align: 'right', value: (bot) => String(bot.attempts ?? 0) },
  ];
  const separators = columns.length; // пробел между колонками плюс один перед колонкой ошибки
  const used = columns.reduce((sum, column) => sum + column.size, 0) + separators;
  columns.push({
    title: I18N.t('watch.column.error'),
    size: Math.max(6, width - used),
    value: (bot) => bot.error || dash,
  });

  const cell = (column, bot) => {
    const value = cut(String(column.value(bot) ?? dash), column.size);
    const padding = ' '.repeat(Math.max(0, column.size - visualWidth(value)));
    return column.align === 'right' ? padding + value : value + padding;
  };
  const header = columns
    .map((column) => cut(column.title, column.size).padEnd(column.size))
    .join(' ')
    .trimEnd();
  const rows = frame.bots.map((bot) => {
    const row = cut(
      columns
        .map((column) => cell(column, bot))
        .join(' ')
        .trimEnd(),
      width,
    );
    return ['failed', 'blocked'].includes(bot.status) ? paint.red(row) : row;
  });
  return [paint.dim(cut(header, width)), ...rows];
}

function frameLines(frame, { color = false } = {}) {
  const paint = palette(color);
  const dash = I18N.t('watch.metric.empty');
  const lines = [];
  lines.push(paint.bold(cut(I18N.t('watch.title', { time: clockOf(frame.generatedAt) || '' }), frame.width)));
  lines.push(
    frame.running ? paint.green(I18N.t('watch.running', { pid: frame.pid })) : paint.red(I18N.t('watch.stopped')),
  );
  if (!frame.running) lines.push(paint.dim(cut(I18N.t('watch.stoppedHint'), frame.width)));
  if (frame.statusFile.error)
    lines.push(paint.red(cut(I18N.t('watch.statusBroken', { error: frame.statusFile.error }), frame.width)));
  else if (!frame.statusFile.present) lines.push(paint.dim(I18N.t('watch.noStatus')));
  else {
    const clock = clockOf(frame.updatedAt);
    const age = ageLabel(frame.ageMs);
    lines.push(
      paint.dim(cut(clock && age ? I18N.t('watch.updated', { time: clock, age }) : I18N.t('watch.never'), frame.width)),
    );
  }
  // Реестр показывается независимо от статуса флота: он может существовать и без запуска.
  if (frame.registry.present)
    lines.push(
      paint.dim(
        cut(
          I18N.t('watch.registry', { count: frame.registry.count === null ? dash : frame.registry.count }),
          frame.width,
        ),
      ),
    );
  if (frame.total > 0 || Object.keys(frame.states).length) {
    lines.push(cut(I18N.t('watch.states', { states: stateSummary(frame.states) || dash }), frame.width));
    lines.push(
      cut(
        `${I18N.t('watch.online', { online: frame.online, total: frame.total })} · ${I18N.t('watch.metrics', {
          login: metricText(frame.metrics.loginMs),
          rtt: metricText(frame.metrics.rttMs),
        })}`,
        frame.width,
      ),
    );
    if (frame.clubTag) lines.push(cut(I18N.t('watch.club', { tag: frame.clubTag }), frame.width));
    if (frame.paused) lines.push(paint.yellow(cut(I18N.t('watch.paused'), frame.width)));
    lines.push('');
    if (frame.bots.length) lines.push(...tableLines(frame, paint));
    else lines.push(paint.dim(I18N.t('watch.empty')));
  }
  if (frame.logLines > 0) {
    lines.push('');
    lines.push(paint.dim(cut(I18N.t('watch.log', { count: frame.logLines }), frame.width)));
    if (!frame.log.length) lines.push(paint.dim(I18N.t('watch.logEmpty')));
    for (const line of frame.log) lines.push(paint.dim(cut(line, frame.width)));
  }
  lines.push('');
  if (!frame.commandErrors.length) lines.push(paint.dim(I18N.t('watch.commandsEmpty')));
  else {
    lines.push(paint.yellow(cut(I18N.t('watch.commands', { count: frame.commandErrors.length }), frame.width)));
    for (const item of frame.commandErrors)
      lines.push(paint.dim(cut(`${clockOf(item.at) || ''} ${item.message}`.trim(), frame.width)));
  }
  return lines;
}

function renderFrame(frame, options = {}) {
  return frameLines(frame, options).join('\n');
}

// ---------------------------------------------------------------- CLI-обвязка

// Глобальные флаги (без значения) снимаются до общего разбора, как в lib/CLI.js#splitGlobals:
// иначе --once/--json съедали бы следующий аргумент. Остальное разбирает lib/Args.js.
const GLOBAL_FLAGS = { json: 'json', quiet: 'quiet', 'no-color': 'noColor' };

function parseArgv(argv = []) {
  const flags = { json: false, quiet: false, noColor: false };
  const rest = [];
  for (const item of argv) {
    const match = typeof item === 'string' ? /^--([a-z-]+)(?:=(.*))?$/.exec(item) : null;
    if (match && Object.prototype.hasOwnProperty.call(GLOBAL_FLAGS, match[1])) {
      flags[GLOBAL_FLAGS[match[1]]] = match[2] === undefined ? true : !['false', '0', 'no'].includes(match[2]);
      continue;
    }
    rest.push(item);
  }
  const { options } = Args.parse(rest);
  return { options, flags };
}

function terminalWidth(env = process.env) {
  const columns = Number(env.COLUMNS);
  if (Number.isFinite(columns) && columns >= MIN_WIDTH) return Math.floor(columns);
  const stream = process.stdout;
  return Number.isFinite(stream?.columns) && stream.columns >= MIN_WIDTH ? Math.floor(stream.columns) : 100;
}

function useColor(flags, env = process.env) {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (flags.noColor) return false;
  return !!process.stdout?.isTTY;
}

// Один цикл дашборда. print — вывод в режиме --json, write — сырой писатель кадра.
// Опции нормализуются ровно один раз — внутри collectFrame; здесь берётся только
// interval/once для управления циклом. cache живёт между кадрами (лог и результаты).
// Возвращает промис, который завершается по --once/--json или по Ctrl+C.
function run({ root = ROOT, options = {}, flags = {}, env = process.env, print, write } = {}) {
  const config = normalizeOptions(options);
  const cache = { log: null, commandErrors: null, commandErrorsAt: 0 };
  const emitJson = typeof print === 'function' ? print : (value) => process.stdout.write(JSON.stringify(value) + '\n');
  const writeRaw = typeof write === 'function' ? write : (chunk) => process.stdout.write(chunk);
  const draw = () => {
    const frame = collectFrame({ root, options, width: terminalWidth(env), cache });
    if (flags.json) {
      emitJson({ ok: true, result: frame });
      return null;
    }
    const text = renderFrame(frame, { color: useColor(flags, env) });
    return { frame, text };
  };

  if (flags.json || config.once) {
    const drawn = draw();
    if (!flags.json && drawn) writeRaw(drawn.text + '\n');
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let previous = 0;
    let stopped = false;
    let timer = null;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      if (timer) clearInterval(timer);
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
      writeRaw(process.stdout?.isTTY ? `${ANSI.reset}\u001b[?25h\n` : '\n');
      resolve();
    };
    // Курсор наверх без полной очистки: экран не мигает, история терминала не рушится.
    // Не-TTY (редирект в файл) получает кадры через пустую строку, без escape-последовательностей.
    const advance = (prior) => {
      if (!process.stdout?.isTTY) {
        if (prior > 0) writeRaw('\n');
        return;
      }
      if (prior > 0) writeRaw(`\u001b[${prior}A\r\u001b[0J`);
      else writeRaw('\u001b[H\u001b[2J');
    };
    const tick = () => {
      const frame = collectFrame({ root, options, width: terminalWidth(env), cache });
      const lines = frameLines(frame, { color: useColor(flags, env) });
      advance(previous);
      writeRaw(lines.join('\n') + '\n');
      previous = lines.length;
    };
    if (process.stdout?.isTTY) writeRaw('\u001b[?25l');
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    tick();
    timer = setInterval(tick, config.interval);
  });
}

async function main(argv = process.argv.slice(2)) {
  const { options, flags } = parseArgv(argv);
  await run({ options, flags });
}

module.exports = {
  ROOT,
  DEFAULT_INTERVAL,
  DEFAULT_LOG_LINES,
  MIN_INTERVAL,
  COMMAND_REFRESH_INTERVAL,
  RESULT_FILES_LIMIT,
  normalizeOptions,
  parseBotsFilter,
  parseArgv,
  readJson,
  tailLines,
  fleetProcess,
  accountRegistry,
  commandFailures,
  collectFrame,
  renderFrame,
  frameLines,
  visualWidth,
  cut,
  run,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
