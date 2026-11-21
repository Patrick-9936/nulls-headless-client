// Интеграция LoginOk + Nulls Connect: фикстура LoginOk кладёт bindToken в аккаунт,
// tools/connect.js bind читает его из --account и шлёт в /games/bind.
// CLI запускается в этом же процессе (require + подмена global.fetch), поэтому
// сеть не нужна и старт Node не оплачивается дважды.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const LoginOkMessage = require('../Messaging/Messages/Server/LoginOkMessage');

const CONNECT = require.resolve('../tools/connect');
const FIXTURE = path.join(__dirname, 'fixtures', 'login-ok-69.bin');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tempRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nulls-int-login-'));
const clean = (root) => fs.rmSync(root, { recursive: true, force: true });

function decodedFixture() {
  const message = new LoginOkMessage();
  message.ByteStream.set(fs.readFileSync(FIXTURE));
  message.decode();
  assert.equal(message.parsed, true, JSON.stringify(message.decodeErrors));
  return message;
}

// Мок messaging: ровно тот контракт, который LoginOkMessage.process ожидает.
function processIntoAccount(message) {
  const account = {};
  const events = { saved: 0, loggedIn: 0 };
  const messaging = {
    account,
    saveAccount() {
      events.saved++;
    },
    onLoggedIn() {
      events.loggedIn++;
    },
  };
  message.process(messaging);
  return { account, events };
}

// Один вызов CLI: процесс общий, кэш модуля сбрасывается ради повторного main().
async function runConnect(args, env = {}) {
  const stdout = [];
  const stderr = [];
  const savedLog = console.log;
  const savedError = console.error;
  const savedArgv = process.argv;
  const savedExit = process.exitCode;
  const savedEnv = {};
  for (const [key, value] of Object.entries(env)) {
    savedEnv[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  // tools/connect.js печатает только через console; поток репортёра node:test не трогаем.
  console.log = (...args) => {
    stdout.push(args.map(String).join(' ') + '\n');
  };
  console.error = (...args) => {
    stderr.push(args.map(String).join(' ') + '\n');
  };
  process.exitCode = undefined;
  try {
    delete require.cache[CONNECT];
    process.argv = [process.execPath, CONNECT, ...args];
    require(CONNECT);
    for (let i = 0; i < 400 && !stdout.length && !stderr.length && !process.exitCode; i++) await sleep(5);
  } finally {
    console.log = savedLog;
    console.error = savedError;
    process.argv = savedArgv;
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  const status = process.exitCode || 0;
  process.exitCode = savedExit;
  delete require.cache[CONNECT];
  return { stdout: stdout.join(''), stderr: stderr.join(''), status };
}

test('LoginOk.process кладёт passToken и bindToken в аккаунт через мок messaging', () => {
  const message = decodedFixture();
  const { account, events } = processIntoAccount(message);
  assert.equal(events.saved, 1);
  assert.equal(events.loggedIn, 1);
  assert.equal(account.hi, 0);
  assert.equal(account.lo, 280648723);
  assert.equal(account.passToken, 'jpF6veey1+CHayqfy9/q');
  assert.equal(account.bindToken.token, message.bindToken);
  assert.match(account.bindToken.token, /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.match(account.bindToken.at, /^\d{4}-\d\d-\d\dT/);
});

test('tools/connect.js bind шлёт bindToken из аккаунта, status отдаёт валидный JSON', async () => {
  const root = tempRoot();
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    const parsed = new URL(String(url));
    calls.push({
      origin: parsed.origin,
      pathname: parsed.pathname,
      query: Object.fromEntries(parsed.searchParams),
      method: options.method || 'GET',
      headers: options.headers || {},
    });
    return {
      status: 200,
      headers: { get: (name) => (String(name).toLowerCase() === 'content-type' ? 'application/json' : null) },
      text: async () => JSON.stringify({ linked: true, pid: '123456789' }),
    };
  };
  try {
    const message = decodedFixture();
    const { account } = processIntoAccount(message);
    const accountFile = path.join(root, 'accounts', 'bot-1.json');
    fs.mkdirSync(path.dirname(accountFile), { recursive: true });
    fs.writeFileSync(accountFile, JSON.stringify(account, null, 2));

    const stateFile = path.join(root, '.runtime', 'connect.json');
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(
      stateFile,
      JSON.stringify({ token: 'bearer-from-state', email: 'user@example.com', at: '2026-11-21T00:00:00.000Z' }),
    );

    const bind = await runConnect(['bind', '--account', accountFile], {
      NC_STATE_FILE: stateFile,
      NC_API_UPSTREAM: 'https://connect.test/api',
    });
    assert.equal(bind.status, 0, JSON.stringify({ stderr: bind.stderr, stdout: bind.stdout }));
    assert.equal(calls.length, 1);
    const printed = JSON.parse(bind.stdout);
    assert.equal(printed.status, 200);
    assert.deepEqual(printed.data, { linked: true, pid: '123456789' });
    assert.equal(bind.stdout.includes('bearer-from-state'), false, 'bearer не должен попадать в stdout');

    const capture = calls[0];
    assert.equal(capture.origin, 'https://connect.test');
    assert.equal(capture.pathname, '/api/games/bind');
    assert.equal(capture.method, 'GET');
    assert.equal(capture.query.bind_token, message.bindToken);
    assert.equal(capture.query.game, 'laser');
    assert.equal(capture.headers.authorization, 'Bearer bearer-from-state');
    assert.equal(capture.headers.accept, 'application/json');

    // status: --json печатает {"ok":true,"result":…} одной строкой.
    const statusRun = await runConnect(['status', '--json'], { NC_STATE_FILE: stateFile });
    assert.equal(statusRun.status, 0, JSON.stringify({ stderr: statusRun.stderr, stdout: statusRun.stdout }));
    const status = JSON.parse(statusRun.stdout);
    assert.equal(status.ok, true);
    assert.equal(status.result.hasToken, true);
    assert.equal(status.result.email, 'u***@example.com');
    assert.equal(status.result.stateFile, stateFile);
    assert.equal(statusRun.stdout.includes('bearer-from-state'), false);
  } finally {
    global.fetch = originalFetch;
    clean(root);
  }
});
