#!/usr/bin/env node
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { parse } = require('../lib/Args');
const Store = require('../lib/Store');
const Accounts = require('../lib/Accounts');
const Platform = require('../utils/Platform');
const ROOT = path.resolve(__dirname, '..'),
  PID = path.join(ROOT, 'fleet.pid'),
  LOG = path.join(ROOT, 'fleet.log');
const LOG_MAX_BYTES = 5 * 1024 * 1024;
const LOG_KEEP = 3;
const LOG_CHECK_INTERVAL = 60000;
const CLEANUP_INTERVAL = 600000;
const CLEANUP_RESULTS_MAX_AGE = 3600000;
const CLEANUP_PROCESSING_MAX_AGE = 600000;
const CLEANUP_STALE_MAX_AGE = 86400000;

function logOptions(options = {}) {
  const maxBytes = Number(options.maxBytes ?? options.logMaxBytes ?? LOG_MAX_BYTES);
  const keep = Number(options.keep ?? options.logKeep ?? LOG_KEEP);
  return {
    maxBytes: Number.isFinite(maxBytes) && maxBytes >= 1024 ? Math.floor(maxBytes) : LOG_MAX_BYTES,
    keep: Number.isInteger(keep) && keep >= 1 && keep <= 20 ? keep : LOG_KEEP,
  };
}

// fleet.log → fleet.log.1 … fleet.log.keep, самый старый удаляется.
// Переименование открытого файла на Windows запрещено, поэтому вызывающие сначала закрывают
// свой дескриптор (FleetLog) либо ротируют до spawn (start). Ошибка переименования не фатальна:
// возвращается false, лог продолжает писаться в тот же файл до следующей попытки.
function rotateLog(file, options = {}) {
  const { maxBytes, keep } = logOptions(options);
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return false;
  }
  if (!stat.isFile() || stat.size < maxBytes) return false;
  try {
    fs.rmSync(`${file}.${keep}`, { force: true });
  } catch {}
  for (let i = keep - 1; i >= 1; i--) {
    try {
      fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`);
    } catch (error) {
      if (error.code !== 'ENOENT') return false;
    }
  }
  try {
    fs.renameSync(file, `${file}.1`);
  } catch {
    return false;
  }
  return true;
}

// Дескриптор лог-файла, который умеет закрыться перед ротацией и открыться заново.
class FleetLog {
  constructor(file, options = {}) {
    this.file = file;
    this.options = logOptions(options);
    this.fd = null;
  }
  open() {
    if (this.fd !== null) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this.fd = fs.openSync(this.file, 'a', 0o600);
  }
  write(chunk) {
    try {
      this.open();
      fs.writeSync(this.fd, typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
    } catch {}
  }
  close() {
    if (this.fd === null) return;
    try {
      fs.closeSync(this.fd);
    } catch {}
    this.fd = null;
  }
  rotateIfNeeded() {
    let stat;
    try {
      stat = fs.statSync(this.file);
    } catch {
      return false;
    }
    if (!stat.isFile() || stat.size < this.options.maxBytes) return false;
    this.close();
    const rotated = rotateLog(this.file, this.options);
    this.open();
    return rotated;
  }
}

// Дублирует stdout/stderr в fleet.log. В `start` дочерний процесс получает stdio 'ignore',
// поэтому единственный писатель в лог — этот tee, и ротация не ломает чужой дескриптор.
function installTee(log) {
  for (const stream of [process.stdout, process.stderr]) {
    const original = stream.write.bind(stream);
    stream.write = (chunk, encoding, callback) => {
      log.write(chunk);
      return original(chunk, encoding, callback);
    };
  }
}

function runCleanup() {
  try {
    const report = Accounts.cleanup(ROOT, {
      resultsMaxAge: CLEANUP_RESULTS_MAX_AGE,
      processingMaxAge: CLEANUP_PROCESSING_MAX_AGE,
      staleMaxAge: CLEANUP_STALE_MAX_AGE,
    });
    if (report.removed) console.log(`очистка .runtime: удалено файлов ${report.removed}`);
    return report;
  } catch (error) {
    console.error(`очистка .runtime: ${error.message}`);
    return null;
  }
}

function ownedPID() {
  const pid = Number(fs.existsSync(PID) ? fs.readFileSync(PID, 'utf8') : 0);
  if (!Number.isInteger(pid) || pid < 1) return null;
  try {
    process.kill(pid, 0);
    if (
      fs.existsSync(`/proc/${pid}/cmdline`) &&
      !fs.readFileSync(`/proc/${pid}/cmdline`).includes(Buffer.from(__filename))
    )
      return null;
    return pid;
  } catch (error) {
    if (error.code === 'EPERM')
      console.error(`fleet.pid указывает на процесс ${pid}, принадлежащий другому пользователю; уберите файл вручную`);
    return null;
  }
}
async function main() {
  const argv = process.argv.slice(2),
    { options, positional } = parse(argv),
    command = positional[0] || 'status';
  if (command === 'status') {
    console.log(
      JSON.stringify({ ...Store.read(path.join(ROOT, 'fleet-status.json'), {}), running: !!ownedPID() }, null, 2),
    );
    return;
  }
  if (command === 'stop') {
    const pid = ownedPID();
    if (pid) process.kill(pid, 'SIGTERM');
    console.log(pid ? 'Остановка запрошена' : 'Процесс не запущен');
    return;
  }
  if (command === 'start') {
    if (ownedPID()) throw new Error('Процесс уже запущен; используйте status или stop');
    // Ротация до открытия файла: на Windows переименовать занятый файл нельзя.
    rotateLog(LOG, logOptions(options));
    const child = spawn(process.execPath, [__filename, 'run', ...argv.slice(1)], {
      cwd: ROOT,
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    child.unref();
    console.log(`Запуск PID ${child.pid}. Проверка: node tools/fleet.js status`);
    return;
  }
  if (['command', 'retry-registration', 'pause', 'resume', 'retry'].includes(command)) {
    if (!ownedPID()) throw new Error('Сначала запустите fleet');
    const action = command === 'retry-registration' ? 'retry' : command === 'command' ? options.action : command;
    if (!action) throw new Error('Нужен --action');
    const id = crypto.randomUUID();
    const file = path.join(ROOT, '.runtime', 'commands', `${id}.json`);
    Store.write(file, { bot: options.bot, all: options.all, action, args: options });
    const result = path.join(ROOT, '.runtime', 'results', `${id}.json`);
    const deadline =
      Date.now() +
      Number(options.timeout || 60000) *
        (options.all ? Store.read(path.join(ROOT, 'fleet-status.json'), {}).requested || 1 : 1);
    while (!fs.existsSync(result)) {
      if (Date.now() > deadline || !ownedPID())
        throw new Error(`Результат ещё не получен. ID: ${id}; не повторяйте действие автоматически`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const value = Store.read(result);
    console.log(JSON.stringify(value, null, 2));
    if (!value.ok || (Array.isArray(value.result) && value.result.some((v) => v.error || v.confirmed === false)))
      process.exitCode = 1;
    return;
  }
  if (command !== 'run') throw new Error('fleet: start|run|status|stop|command|retry|pause|resume');
  if (ownedPID()) throw new Error('Процесс уже запущен');
  const log = new FleetLog(LOG, logOptions(options));
  log.rotateIfNeeded();
  installTee(log);
  const Fleet = require('../lib/Fleet');
  const fleet = new Fleet(ROOT, options);
  fs.writeFileSync(PID, String(process.pid), { mode: 0o600 });
  Platform.fileModeSecure(PID);
  const wakeLock = Platform.wakeLock(true);
  const rotateTimer = setInterval(() => log.rotateIfNeeded(), LOG_CHECK_INTERVAL);
  rotateTimer.unref?.();
  runCleanup();
  const cleanupTimer = setInterval(runCleanup, CLEANUP_INTERVAL);
  cleanupTimer.unref?.();
  const stop = () => {
    clearInterval(rotateTimer);
    clearInterval(cleanupTimer);
    fleet.stop();
    if (fs.existsSync(PID) && Number(fs.readFileSync(PID, 'utf8')) === process.pid) fs.unlinkSync(PID);
    if (wakeLock) Platform.wakeLock(false);
    log.close();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  global.Debugger = Object.fromEntries(
    ['info', 'warn', 'error'].map((k) => [
      k,
      (...args) => console.log(new Date().toISOString(), k.toUpperCase(), ...args),
    ]),
  );
  fleet.start();
}
if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
module.exports = { rotateLog, FleetLog, logOptions };
