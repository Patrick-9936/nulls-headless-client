#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const {spawn, execFileSync} = require('node:child_process');
const {parse} = require('../lib/Args');
const Store = require('../lib/Store');
const ROOT = path.resolve(__dirname, '..'), PID = path.join(ROOT, 'fleet.pid');
function ownedPID() {
  const pid = Number(fs.existsSync(PID) ? fs.readFileSync(PID, 'utf8') : 0);
  if (!Number.isInteger(pid) || pid < 1) return null;
  try {
    process.kill(pid, 0);
    if (fs.existsSync(`/proc/${pid}/cmdline`) && !fs.readFileSync(`/proc/${pid}/cmdline`).includes(Buffer.from(__filename))) return null;
    return pid;
  } catch {return null;}
}
async function main() {
  const argv = process.argv.slice(2), {options, positional} = parse(argv), command = positional[0] || 'status';
  if (command === 'status') {
    console.log(JSON.stringify({...Store.read(path.join(ROOT, 'fleet-status.json'), {}), running: !!ownedPID()}, null, 2)); return;
  }
  if (command === 'stop') {
    const pid = ownedPID(); if (pid) process.kill(pid, 'SIGTERM');
    console.log(pid ? 'Остановка запрошена' : 'Процесс не запущен'); return;
  }
  if (command === 'start') {
    if (ownedPID()) throw new Error('Процесс уже запущен; используйте status или stop');
    const fd = fs.openSync(path.join(ROOT, 'fleet.log'), 'a', 0o600);
    const child = spawn(process.execPath, [__filename, 'run', ...argv.slice(1)], {cwd: ROOT, detached: true, stdio: ['ignore', fd, fd]});
    child.unref(); fs.closeSync(fd); console.log(`Запуск PID ${child.pid}. Проверка: node tools/fleet.js status`); return;
  }
  if (['command', 'retry-registration', 'pause', 'resume', 'retry'].includes(command)) {
    if (!ownedPID()) throw new Error('Сначала запустите fleet');
    const action = command === 'retry-registration' ? 'retry' : command === 'command' ? options.action : command;
    if (!action) throw new Error('Нужен --action');
    const id = crypto.randomUUID(); const file = path.join(ROOT, '.runtime', 'commands', `${id}.json`);
    Store.write(file, {bot: options.bot, all: options.all, action, args: options});
    const result = path.join(ROOT, '.runtime', 'results', `${id}.json`);
    const deadline = Date.now() + (Number(options.timeout || 60000) * (options.all ? Store.read(path.join(ROOT, 'fleet-status.json'), {}).requested || 1 : 1));
    while (!fs.existsSync(result)) {
      if (Date.now() > deadline || !ownedPID()) throw new Error(`Результат ещё не получен. ID: ${id}; не повторяйте действие автоматически`);
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    const value = Store.read(result); console.log(JSON.stringify(value, null, 2));
    if (!value.ok || (Array.isArray(value.result) && value.result.some(v => v.error || v.confirmed === false))) process.exitCode = 1;
    return;
  }
  if (command !== 'run') throw new Error('fleet: start|run|status|stop|command|retry|pause|resume');
  if (ownedPID()) throw new Error('Процесс уже запущен');
  const Fleet = require('../lib/Fleet'); const fleet = new Fleet(ROOT, options);
  fs.writeFileSync(PID, String(process.pid), {mode: 0o600});
  let wakeLock = false;
  try {execFileSync('termux-wake-lock', [], {timeout: 3000, stdio: 'ignore'}); wakeLock = true;} catch {}
  const stop = () => {
    fleet.stop();
    if (fs.existsSync(PID) && Number(fs.readFileSync(PID, 'utf8')) === process.pid) fs.unlinkSync(PID);
    if (wakeLock) try {execFileSync('termux-wake-unlock', [], {timeout: 3000, stdio: 'ignore'});} catch {}
  };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  global.Debugger = Object.fromEntries(['info', 'warn', 'error'].map(k => [k, (...args) => console.log(new Date().toISOString(), k.toUpperCase(), ...args)]));
  fleet.start();
}
main().catch(error => {console.error(error.message); process.exitCode = 1;});
