const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawnSync, execFile } = require('node:child_process');
const { promisify } = require('node:util');

const { maybeConnectBind, connectBindRequested, splitGlobals } = require('../lib/CLI');

const ROOT = path.resolve(__dirname, '..');
const TOOL = path.join(ROOT, 'tools', 'connect.js');
const JWT = 'header.payload.signature';

let server;
let base;
let unbindMode = 'ok';
const requests = [];
const tmpDirs = [];

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function handle(req, res, body) {
  const url = new URL(req.url, 'http://127.0.0.1');
  requests.push({ method: req.method, pathname: url.pathname, search: url.searchParams, headers: req.headers, body });
  if (url.pathname === '/api/games/unbind') {
    if (unbindMode === 'ok') return json(res, 200, { unbound: true });
    if (unbindMode === 'post-only') {
      return req.method === 'POST' ? json(res, 200, { unbound: true }) : json(res, 405, { error: 'method' });
    }
    return req.method === 'POST' ? json(res, 405, { error: 'method' }) : json(res, 404, { error: 'not found' });
  }
  if (url.pathname === '/api/games/bind') return json(res, 200, { bound: true, bind_token: JWT });
  if (url.pathname === '/api/games/links') return json(res, 200, { accounts: [{ player_info: { tag: '#ABC' } }] });
  if (url.pathname === '/api/games/token') return json(res, 200, { token: 'player-token-abcdef' });
  if (url.pathname === '/api/auth/login.v2') {
    return url.searchParams.get('pin') ? json(res, 200, { token: 'bearer-from-cli' }) : json(res, 200, { pin: true });
  }
  return json(res, 404, { error: 'not found' });
}

const execFileAsync = promisify(execFile);

// spawnSync здесь нельзя: он блокирует event loop родителя, и локальный сервер
// не успевает ответить дочернему процессу (каждый запрос ловил бы таймаут).
async function runCli(args, stateFile) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [TOOL, ...args], {
      timeout: 20000,
      env: {
        ...process.env,
        NC_API_UPSTREAM: `${base}/api`,
        NC_STATE_FILE: stateFile,
        NC_PROFILES_UPSTREAM: `${base}/profiles`,
      },
    });
    return { status: 0, out: String(stdout || '').trim(), err: String(stderr || '').trim() };
  } catch (error) {
    return {
      status: typeof error.code === 'number' ? error.code : 1,
      out: String(error.stdout || '').trim(),
      err: String(error.stderr || '').trim(),
    };
  }
}

function tempState() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nulls-connect-cli-'));
  tmpDirs.push(dir);
  return path.join(dir, 'connect.json');
}

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => handle(req, res, body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

test('unbind через локальный сервер: GET с bind_token и bearer', async () => {
  requests.length = 0;
  unbindMode = 'ok';
  const result = await runCli(['unbind', '--bind-token', JWT, '--token', 'bearer-x', '--json'], tempState());
  assert.equal(result.status, 0, result.err);
  const parsed = JSON.parse(result.out);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.result.unbound, true);
  assert.equal(parsed.result.status, 200);
  assert.equal(result.out.split('\n').length, 1);

  const call = requests.find((item) => item.pathname === '/api/games/unbind');
  assert.equal(call.method, 'GET');
  assert.equal(call.search.get('bind_token'), JWT);
  assert.equal(call.search.get('game'), 'laser');
  assert.equal(call.headers.authorization, 'Bearer bearer-x');
});

test('unbind: POST-fallback, когда GET отвечает 405', async () => {
  requests.length = 0;
  unbindMode = 'post-only';
  const result = await runCli(['unbind', '--bind-token', JWT, '--token', 'bearer-x', '--json'], tempState());
  assert.equal(result.status, 0, result.err);
  const parsed = JSON.parse(result.out);
  assert.equal(parsed.result.unbound, true);
  const made = requests.filter((item) => item.pathname === '/api/games/unbind');
  assert.deepEqual(
    made.map((item) => item.method),
    ['GET', 'POST'],
  );
  assert.deepEqual(JSON.parse(made[1].body), { bind_token: JWT, game: 'laser' });
  assert.equal(made[1].headers.authorization, 'Bearer bearer-x');
});

test('unbind: 404+405 → CONNECT_UNSUPPORTED и понятный текст, кода 0 нет', async () => {
  requests.length = 0;
  unbindMode = 'unsupported';
  const result = await runCli(['unbind', '--bind-token', JWT, '--token', 'bearer-x', '--json'], tempState());
  assert.equal(result.status, 1);
  assert.equal(result.out, '');
  assert.match(result.err, /CONNECT_UNSUPPORTED/);
  assert.match(result.err, /не поддерживает отвязку/);
  assert.equal(requests.filter((item) => item.pathname === '/api/games/unbind').length, 2);
});

test('каждая команда tools/connect.js: --json и pretty-JSON без флага', async () => {
  const cases = [
    { name: 'status', args: [] },
    { name: 'links', args: ['links', '--token', 'bearer-x'] },
    { name: 'pin', args: ['pin', '--email', 'user@example.com'] },
    { name: 'confirm', args: ['confirm', '--email', 'user@example.com', '--pin', '1234'] },
    { name: 'bind', args: ['bind', '--bind-token', JWT, '--token', 'bearer-x'] },
    { name: 'unbind', args: ['unbind', '--bind-token', JWT, '--token', 'bearer-x'] },
    { name: 'token', args: ['token', '--player-id', '123', '--token', 'bearer-x'] },
    { name: 'logout', args: ['logout'] },
  ];
  for (const item of cases) {
    const baseArgs = item.args.length ? item.args : ['status'];
    for (const form of [
      { flag: '--json', json: true },
      { flag: null, json: false },
    ]) {
      unbindMode = 'ok';
      const argv = form.flag ? [baseArgs[0], form.flag, ...baseArgs.slice(1)] : baseArgs;
      const result = await runCli(argv, tempState());
      const label = `${item.name} ${form.flag || '(без флага)'}`;
      assert.equal(result.status, 0, `${label}: ${result.err}`);
      const parsed = JSON.parse(result.out);
      if (form.json) {
        assert.equal(parsed.ok, true, `${label}: ok`);
        assert.ok('result' in parsed, `${label}: result`);
        assert.equal(result.out.split('\n').length, 1, `${label}: одна строка`);
        assert.ok(!result.out.includes(JWT), `${label}: bind-token не утёк`);
        assert.ok(!result.out.includes('bearer-x'), `${label}: bearer не утёк`);
      } else {
        assert.equal(parsed.ok, undefined, `${label}: pretty-JSON без обёртки`);
        if (item.name === 'logout') assert.equal(parsed.removed, false, `${label}: removed`);
      }
    }
  }
});

test('--json=false эквивалентен обычному pretty-JSON (status и links)', async () => {
  for (const args of [[], ['links', '--token', 'bearer-x']]) {
    unbindMode = 'ok';
    const state = tempState();
    const baseArgs = args.length ? args : ['status'];
    const pretty = await runCli(baseArgs, state);
    const explicit = await runCli([baseArgs[0], '--json=false', ...baseArgs.slice(1)], state);
    assert.equal(pretty.status, 0, pretty.err);
    assert.equal(explicit.status, 0, explicit.err);
    assert.deepEqual(JSON.parse(pretty.out), JSON.parse(explicit.out));
    assert.ok(!explicit.out.startsWith('{"ok":'), '--json=false не включает обёртку');
  }
});

test('connect-bind: флаг включается только для login/create-account', () => {
  assert.equal(connectBindRequested({ connectBind: true }, 'login'), true);
  assert.equal(connectBindRequested({ connectBind: true }, 'create-account'), true);
  assert.equal(connectBindRequested({ connectBind: true }, 'friends'), false);
  assert.equal(connectBindRequested({}, 'login'), false);
  assert.equal(connectBindRequested({ connectBind: false }, 'login'), false);

  const parsed = splitGlobals(['login', '--connect-bind', '--account', 'accounts/bot-1.json']);
  assert.equal(parsed.flags.connectBind, true);
  assert.deepEqual(parsed.argv, ['login', '--account', 'accounts/bot-1.json']);
  assert.equal(splitGlobals(['login', '--connect-bind=false']).flags.connectBind, false);
  assert.equal(splitGlobals(['login', '--connect-bind=0']).flags.connectBind, false);
});

test('connect-bind: skip без bind-token — Connect даже не загружается', async () => {
  let loaded = 0;
  const deps = {
    get Connect() {
      loaded++;
      return { tokenOf: () => 'bearer', bind: async () => assert.fail('bind must not run') };
    },
  };
  const outcome = await maybeConnectBind({ account: {} }, {}, deps);
  assert.deepEqual(outcome, { skipped: true, reason: 'no-bind-token' });
  assert.equal(loaded, 0);
});

test('connect-bind: skip без bearer, bind не вызывается', async () => {
  let bound = 0;
  const Connect = {
    tokenOf: () => null,
    bind: async () => {
      bound++;
      return { status: 200, data: {} };
    },
  };
  const outcome = await maybeConnectBind({ account: { bindToken: { token: JWT, at: 'now' } } }, {}, { Connect });
  assert.deepEqual(outcome, { skipped: true, reason: 'no-bearer' });
  assert.equal(bound, 0);
});

test('connect-bind: успешный bind, токены в data замаскированы', async () => {
  const seen = [];
  const Connect = {
    tokenOf: (explicit) => explicit,
    bind: async (jwt, options) => {
      seen.push({ jwt, options });
      return { status: 200, data: { bound: true, token: 'secret-bearer', nested: { bind_token: JWT } } };
    },
  };
  const outcome = await maybeConnectBind(
    { account: { bindToken: { token: JWT } } },
    { connectToken: 'explicit-bearer' },
    { Connect },
  );
  assert.equal(outcome.ok, true);
  assert.equal(outcome.status, 200);
  assert.equal(outcome.data.token, '[скрыто, 13 символов]');
  assert.equal(outcome.data.nested.bind_token, `[скрыто, ${JWT.length} символов]`);
  const text = JSON.stringify(outcome);
  assert.ok(!text.includes('secret-bearer'));
  assert.ok(!text.includes(JWT));
  assert.deepEqual(seen, [{ jwt: JWT, options: { token: 'explicit-bearer', game: undefined } }]);
});

test('connect-bind: ошибка upstream → skipped, а не падение', async () => {
  const Connect = {
    tokenOf: () => 'bearer',
    bind: async () => {
      const error = new Error('/games/bind: HTTP 502');
      error.code = 'http';
      error.status = 502;
      throw error;
    },
  };
  const outcome = await maybeConnectBind({ account: { bindToken: JWT } }, {}, { Connect });
  assert.deepEqual(outcome, { skipped: true, reason: 'http', status: 502, message: '/games/bind: HTTP 502' });
});

test('help содержит --connect-bind и unbind в tools/connect.js', async () => {
  const main = spawnSync(process.execPath, [path.join(ROOT, 'Program.js'), 'help'], {
    encoding: 'utf8',
    timeout: 20000,
    env: { ...process.env, NC_API_UPSTREAM: `${base}/api` },
  });
  assert.equal(main.status, 0, main.stderr);
  assert.match(main.stdout, /--connect-bind/);

  const tool = await runCli(['--help'], tempState());
  assert.equal(tool.status, 0, tool.err);
  assert.match(tool.out, /unbind/);
});
