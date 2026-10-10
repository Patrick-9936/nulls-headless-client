#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const {spawn} = require('node:child_process');
const {parse} = require('../lib/Args'), Store = require('../lib/Store');
const ROOT = path.resolve(__dirname, '..'), DIR = path.join(ROOT, '.runtime/test-session');
const PID = path.join(DIR, 'pid'), STATUS = path.join(DIR, 'status.json');
function owned() {
  try {const pid = Number(fs.readFileSync(PID, 'utf8')); if (!Number.isInteger(pid) || pid < 1) return null;
    process.kill(pid, 0); return fs.readFileSync(`/proc/${pid}/cmdline`).includes(Buffer.from(__filename)) ? pid : null;
  } catch {return null;}
}
const {options, positional} = parse(process.argv.slice(2)), command = positional[0] || 'status';
if (command === 'status') {console.log(JSON.stringify({...Store.read(STATUS, {}), running: !!owned()}, null, 2));}
else if (command === 'stop') {const pid = owned(); if (pid) process.kill(pid, 'SIGTERM'); console.log(pid ? 'Stopping both workers' : 'Not running');}
else if (['start', 'run'].includes(command)) {
  if (owned()) throw new Error('Test session already running');
  const minutes = options.until ? (Date.parse(options.until) - Date.now()) / 60000 : Number(options.minutes ?? 60), budget = Number(options.rssMb ?? 320);
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 60 || !Number.isFinite(budget) || budget < 192 || budget > 512) throw new Error('Test limits: minutes 1..60, RSS 192..512 MB');
  new (require('../lib/CandidateRunner'))(ROOT, {...options, rssMb: 160});
  fs.mkdirSync(DIR, {recursive: true, mode: 0o700});
  if (command === 'start') {
    const fd = fs.openSync(path.join(DIR, 'run.log'), 'w', 0o600);
    const child = spawn(process.execPath, [__filename, 'run', ...process.argv.slice(3)], {cwd: ROOT, detached: true, stdio: ['ignore', fd, fd]});
    child.unref(); fs.closeSync(fd); console.log(`Test session PID ${child.pid}; duration ${minutes} minutes`);
  } else {
    fs.writeFileSync(PID, String(process.pid), {mode: 0o600});
    let stopped = false, reason = null, bot = null;
    const startedAt = Date.now(), endsAt = options.until ? Date.parse(options.until) : startedAt + minutes * 60000;
    const proxy = spawn(process.execPath, ['--max-old-space-size=64', path.join(ROOT, 'tools/proxy-watch.js'), 'run', '--parallel', '12', '--limit', '240', '--timeout', '2500', '--interval', '120'], {cwd: ROOT, stdio: 'ignore'});
    const rss = pid => {try {return Number(fs.readFileSync(`/proc/${pid}/status`, 'utf8').match(/VmRSS:\s+(\d+)/)[1]) * 1024;} catch {return 0;}};
    function save() {Store.write(STATUS, {pid: process.pid, running: !stopped, startedAt: new Date(startedAt).toISOString(), endsAt: new Date(endsAt).toISOString(),
      botPid: bot?.pid || null, proxyPid: proxy.pid, rssBytes: rss(process.pid) + rss(proxy.pid) + (bot ? rss(bot.pid) : 0), rssLimitMB: budget,
      reason, max: options.max !== undefined && Number(options.max) === 0 ? null : Number(options.max ?? 500), proxySources: 8});}
    function stop(why) {if (stopped) return; stopped = true; reason = why; clearInterval(timer); clearTimeout(deadline);
      if (bot) bot.kill('SIGTERM'); proxy.kill('SIGTERM'); save(); if (owned() === process.pid) fs.unlinkSync(PID);}
    proxy.on('error', error => stop(`proxy spawn: ${error.message}`));
    proxy.on('exit', () => stop('proxy-worker-exited'));
    function startBot() {
      const flags = ['--initial', String(options.initial ?? 10), '--max', String(options.max ?? 500), '--grow-seconds', String(options.growSeconds ?? 1),
        '--grow-by', String(options.growBy ?? 2), '--minutes', String(Math.max(1, (endsAt - Date.now()) / 60000)), '--proxy-pool', 'working-proxies.json'];
      if (options.manifest) flags.push('--manifest', options.manifest);
      if (options.prefix) flags.push('--prefix', options.prefix);
      if (options.name) flags.push('--name', options.name);
      if (options.regions) flags.push('--regions', options.regions);
      if (options.battleTransport) flags.push('--battle-transport', options.battleTransport);
      if (options.maxQueued !== undefined) flags.push('--max-queued', String(options.maxQueued));
      bot = spawn(process.execPath, ['--max-old-space-size=128', path.join(ROOT, 'tools/candidates.js'), 'run', ...flags], {cwd: ROOT, stdio: 'ignore'});
      bot.on('error', error => stop(`bot spawn: ${error.message}`)); bot.on('exit', () => stop('bot-worker-exited'));
    }
    const timer = setInterval(() => {
      if (stopped) return;
      if (rss(process.pid) + rss(proxy.pid) + (bot ? rss(bot.pid) : 0) > budget * 1024 * 1024) return stop('rss-limit');
      save();
    }, 2000);
    const deadline = setTimeout(() => stop('session-expired'), minutes * 60000);
    process.once('SIGINT', () => stop('user-stopped')); process.once('SIGTERM', () => stop('user-stopped')); startBot(); save();
  }
} else throw new Error('test-session: start|run|status|stop');
