#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const {spawn} = require('node:child_process');
const {parse} = require('../lib/Args'), Store = require('../lib/Store');
const ROOT = path.resolve(__dirname, '..'), DIR = path.join(ROOT, '.runtime/candidates'), PID = path.join(DIR, 'pid');
function owned() {
  const pid = Number(fs.existsSync(PID) ? fs.readFileSync(PID, 'utf8') : 0);
  try {if (!Number.isInteger(pid) || pid < 1) return null; process.kill(pid, 0);
    return fs.readFileSync(`/proc/${pid}/cmdline`).includes(Buffer.from(__filename)) ? pid : null;
  } catch {return null;}
}
async function main() {
  const {options, positional} = parse(process.argv.slice(2)), command = positional[0] || 'status';
  if (command === 'status') {console.log(JSON.stringify({...Store.read(path.join(DIR, 'status.json'), {}), running: !!owned()}, null, 2)); return;}
  if (command === 'stop') {const pid = owned(); if (pid) process.kill(pid, 'SIGTERM'); console.log(pid ? 'Stopping' : 'Not running'); return;}
  if (!['start', 'run'].includes(command)) throw new Error('candidates: start|run|status|stop');
  if (owned()) throw new Error('Candidates runner already running');
  const Runner = require('../lib/CandidateRunner');
  // Validate before spawning. Account contents are never logged or passed in process arguments.
  const runner = new Runner(ROOT, options); fs.mkdirSync(DIR, {recursive: true, mode: 0o700});
  if (command === 'start') {
    const log = path.join(DIR, 'run.log');
    if (fs.existsSync(log) && fs.statSync(log).size > 1024 * 1024) fs.renameSync(log, log + '.previous');
    const fd = fs.openSync(log, 'a', 0o600);
    const child = spawn(process.execPath, ['--max-old-space-size=128', __filename, 'run', ...process.argv.slice(3)],
      {cwd: ROOT, detached: true, stdio: ['ignore', fd, fd]});
    child.unref(); fs.closeSync(fd); console.log(`Candidates PID ${child.pid}`); return;
  }
  const minutes = Number(options.minutes ?? 60);
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 720) throw new Error('--minutes: 1..720');
  global.Debugger = {info() {}, warn() {}, error() {}};
  fs.writeFileSync(PID, String(process.pid), {mode: 0o600});
  let deadline;
  const stop = () => {clearTimeout(deadline); runner.stop(); if (owned() === process.pid) fs.unlinkSync(PID);};
  runner.onStop = stop;
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  deadline = setTimeout(() => {runner.stopReason = 'session-expired'; stop();}, minutes * 60000);
  runner.start();
}
main().catch(error => {console.error(error.message); process.exitCode = 1;});
