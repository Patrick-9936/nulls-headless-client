const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const Connect = require('../lib/Connect');
const LoginOkMessage = require('../Messaging/Messages/Server/LoginOkMessage');
const ByteStream = require('../DataStream/ByteStream');
const { version } = require('../package.json');

const originalFetch = global.fetch;
const originalDebugger = global.Debugger;
const calls = [];
const logs = [];
let tmpRoot;
let stateFile;

function response(status, body) {
  const text = body === undefined ? '' : JSON.stringify(body);
  return {
    status,
    headers: { get: (key) => (key.toLowerCase() === 'content-type' ? 'application/json' : null) },
    text: async () => text,
  };
}

function installFetch(handler) {
  global.fetch = async (url, options) => {
    const parsed = url instanceof URL ? url : new URL(String(url));
    calls.push({ url: parsed, options });
    return handler(parsed, options);
  };
}

function lastCall() {
  return calls[calls.length - 1];
}

function modernPayload(jwt) {
  const stream = new ByteStream();
  stream.writeVInt(0);
  stream.writeVInt(0);
  stream.writeVInt(0);
  stream.writeVInt(9999);
  stream.writeBoolean(false);
  stream.writeLong(1, 2);
  stream.writeLong(0, 0);
  stream.writeString('2026-11-21T00:00:00Z');
  stream.writeString('2026-11-21');
  stream.writeString('session-token');
  for (let i = 0; i < 4; i++) stream.writeOptionalString(null);
  stream.writeString('RU');
  stream.writeString('https://assets.example/');
  if (jwt) stream.writeOptionalString(jwt);
  return Buffer.from(stream.payload.slice(0, stream.offset));
}

function legacyPayload(jwt) {
  const stream = new ByteStream();
  stream.writeInt(1);
  stream.writeInt(2);
  stream.writeInt(0);
  stream.writeInt(0);
  stream.writeString('legacy-session');
  if (jwt) stream.writeOptionalString(jwt);
  return Buffer.from(stream.payload.slice(0, stream.offset));
}

function buildJwt() {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ game: 'laser', bind: true, pid: 123, exp: 9999999999 })).toString(
    'base64url',
  );
  return `${header}.${payload}.signature_abc123`;
}

function processMessage(message) {
  const account = {};
  let saved = 0;
  let loggedIn = 0;
  message.process({
    account,
    saveAccount() {
      saved++;
    },
    onLoggedIn() {
      loggedIn++;
    },
  });
  return { account, saved, loggedIn };
}

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nulls-connect-'));
  stateFile = path.join(tmpRoot, 'connect.json');
  global.Debugger = {
    info: (...args) => logs.push(args.join(' ')),
    warn: (...args) => logs.push(args.join(' ')),
    error: (...args) => logs.push(args.join(' ')),
  };
});

after(() => {
  global.fetch = originalFetch;
  global.Debugger = originalDebugger;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('requestPin sends a GET with email, game, locale and can_register', async () => {
  installFetch(() => response(200, { pin_required: true, can_register: true }));
  const result = await Connect.requestPin('user@example.com');
  const call = lastCall();
  assert.equal(result.status, 200);
  assert.equal(call.options.method, 'GET');
  assert.equal(call.url.origin, 'https://connect.nulls.gg');
  assert.equal(call.url.pathname, '/api/auth/login.v2');
  assert.equal(call.url.searchParams.get('email'), 'user@example.com');
  assert.equal(call.url.searchParams.get('game'), 'laser');
  assert.equal(call.url.searchParams.get('locale'), 'ru');
  assert.equal(call.url.searchParams.get('can_register'), 'true');
  assert.equal(call.options.headers['user-agent'], `nulls-headless-client/${version}`);
});

test('confirmPin persists the token with 0600 and masks the e-mail in logs', async () => {
  logs.length = 0;
  installFetch(() => response(200, { token: 'bearer-secret' }));
  const result = await Connect.confirmPin('alice@example.com', '1234', { stateFile });
  assert.equal(result.status, 200);
  assert.equal(result.data.token, 'bearer-secret');

  const stored = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(stored.token, 'bearer-secret');
  assert.equal(stored.email, 'alice@example.com');
  assert.equal(typeof stored.at, 'string');
  assert.equal(fs.statSync(stateFile).mode & 0o777, 0o600);

  assert.equal(Connect.maskEmail('alice@example.com'), 'a***@example.com');
  const text = logs.join('\n');
  assert.match(text, /a\*\*\*@example\.com/);
  assert.ok(!text.includes('alice@example.com'));
  assert.ok(!text.includes('bearer-secret'));

  const state = Connect.status({ stateFile });
  assert.equal(state.hasToken, true);
  assert.equal(state.email, 'a***@example.com');
  assert.ok(!('token' in state));

  const removed = Connect.logout({ stateFile });
  assert.equal(removed.removed, true);
  assert.equal(Connect.status({ stateFile }).hasToken, false);
});

test('a 401 becomes a structured http error with status 401', async () => {
  installFetch(() => response(401, { error: 'unauthorized' }));
  await assert.rejects(Connect.requestPin('user@example.com'), (error) => {
    assert.equal(error.name, 'ConnectError');
    assert.equal(error.code, 'http');
    assert.equal(error.status, 401);
    return true;
  });
});

test('a timeout becomes a structured timeout error', async () => {
  installFetch(() => {
    const error = new Error('The operation was aborted due to timeout');
    error.name = 'TimeoutError';
    throw error;
  });
  await assert.rejects(Connect.requestPin('user@example.com'), (error) => {
    assert.equal(error.code, 'timeout');
    return true;
  });
});

test('bind sends the bearer header and the bind_token query', async () => {
  const jwt = buildJwt();
  installFetch(() => response(200, { bound: true }));
  const result = await Connect.bind(jwt, { token: 'bearer-x' });
  const call = lastCall();
  assert.equal(result.status, 200);
  assert.equal(call.url.pathname, '/api/games/bind');
  assert.equal(call.url.searchParams.get('bind_token'), jwt);
  assert.equal(call.url.searchParams.get('game'), 'laser');
  assert.equal(call.options.headers.authorization, 'Bearer bearer-x');
});

test('unbind sends the bearer header and the bind_token query', async () => {
  const jwt = buildJwt();
  installFetch(() => response(200, { unbound: true }));
  const result = await Connect.unbind(jwt, { token: 'bearer-x' });
  const call = lastCall();
  assert.equal(result.status, 200);
  assert.equal(call.url.pathname, '/api/games/unbind');
  assert.equal(call.url.searchParams.get('bind_token'), jwt);
  assert.equal(call.url.searchParams.get('game'), 'laser');
  assert.equal(call.options.method, 'GET');
  assert.equal(call.options.headers.authorization, 'Bearer bearer-x');
});

test('unbind falls back to a JSON POST on 405', async () => {
  const jwt = buildJwt();
  const before = calls.length;
  installFetch((url, options) =>
    options.method === 'POST' ? response(200, { unbound: true }) : response(405, { error: 'method not allowed' }),
  );
  const result = await Connect.unbind(jwt, { token: 'bearer-x' });
  assert.equal(result.status, 200);
  const made = calls.slice(before);
  assert.equal(made.length, 2);
  assert.equal(made[0].options.method, 'GET');
  assert.equal(made[1].url.pathname, '/api/games/unbind');
  assert.equal(made[1].options.method, 'POST');
  assert.equal(made[1].options.headers.authorization, 'Bearer bearer-x');
  assert.equal(made[1].url.searchParams.get('bind_token'), null);
  assert.deepEqual(JSON.parse(made[1].options.body), { bind_token: jwt, game: 'laser' });
});

test('unbind reports CONNECT_UNSUPPORTED when the route itself is missing', async () => {
  const jwt = buildJwt();
  const before = calls.length;
  // FastAPI router 404: exactly what connect.nulls.gg returns for /games/unbind.
  installFetch(() => response(404, { detail: 'Not Found' }));
  await assert.rejects(Connect.unbind(jwt, { token: 'bearer-x' }), (error) => {
    assert.equal(error.name, 'ConnectError');
    assert.equal(error.code, 'CONNECT_UNSUPPORTED');
    assert.equal(error.kind, 'server');
    assert.equal(error.retryable, false);
    assert.equal(error.status, 404);
    assert.match(error.message, /не поддерживает отвязку/);
    assert.deepEqual(error.details, { endpoint: '/games/unbind', getStatus: 404, postStatus: 404 });
    return true;
  });
  // One POST fallback is still attempted for builds that expose only POST.
  assert.equal(calls.length - before, 2);
});

test('unbind reports CONNECT_NOT_LINKED when the route exists but the link does not', async () => {
  const jwt = buildJwt();
  const before = calls.length;
  installFetch(() => response(404, { detail: 'bind token is not linked to any account' }));
  await assert.rejects(Connect.unbind(jwt, { token: 'bearer-x' }), (error) => {
    assert.equal(error.code, 'CONNECT_NOT_LINKED');
    assert.equal(error.kind, 'server');
    assert.equal(error.retryable, false);
    assert.equal(error.status, 404);
    assert.match(error.message, /Связь с игровым аккаунтом не найдена/);
    assert.deepEqual(error.details, { endpoint: '/games/unbind', status: 404 });
    return true;
  });
  assert.equal(calls.length - before, 1);
});

test('unbind treats a 405 as a live route and reports missing after the POST fallback', async () => {
  const jwt = buildJwt();
  const before = calls.length;
  installFetch((url, options) =>
    options.method === 'POST'
      ? response(404, { detail: 'Not Found' })
      : response(405, { detail: 'Method Not Allowed' }),
  );
  await assert.rejects(Connect.unbind(jwt, { token: 'bearer-x' }), (error) => {
    assert.equal(error.code, 'CONNECT_UNSUPPORTED');
    assert.equal(error.status, 404);
    assert.deepEqual(error.details, { endpoint: '/games/unbind', getStatus: 405, postStatus: 404 });
    return true;
  });
  assert.equal(calls.length - before, 2);
});

test('unbind reports CONNECT_NOT_LINKED for a POST 400 that says the account is not linked', async () => {
  const jwt = buildJwt();
  installFetch((url, options) =>
    options.method === 'POST' ? response(400, { detail: 'account not linked' }) : response(405, {}),
  );
  await assert.rejects(Connect.unbind(jwt, { token: 'bearer-x' }), (error) => {
    assert.equal(error.code, 'CONNECT_NOT_LINKED');
    assert.equal(error.status, 400);
    return true;
  });
});

test('unbind keeps a rejected bearer as a plain HTTP error, not as unsupported', async () => {
  const jwt = buildJwt();
  installFetch(() => response(403, { detail: 'Invalid authentication credentials' }));
  await assert.rejects(Connect.unbind(jwt, { token: 'bearer-x' }), (error) => {
    assert.equal(error.code, 'http');
    assert.equal(error.status, 403);
    assert.doesNotMatch(error.message, /не поддерживает отвязку/);
    return true;
  });
});

test('unbind treats a GET 501 as unsupported without a POST attempt', async () => {
  const jwt = buildJwt();
  const before = calls.length;
  installFetch(() => response(501));
  await assert.rejects(Connect.unbind(jwt, { token: 'bearer-x' }), (error) => {
    assert.equal(error.code, 'CONNECT_UNSUPPORTED');
    assert.match(error.message, /не поддерживает отвязку/);
    return true;
  });
  assert.equal(calls.length - before, 1);
});

test('links and gameToken return structures and never print anything', async () => {
  const printed = [];
  const originalLog = console.log;
  console.log = (...args) => printed.push(args.join(' '));
  try {
    installFetch((url) => {
      if (url.pathname.endsWith('/games/links')) {
        return response(200, { accounts: [{ player_info: { tag: '#ABC', score: 1 } }] });
      }
      return response(200, { token: 'player-token' });
    });
    const links = await Connect.links({ token: 'bearer-x' });
    assert.equal(typeof links.status, 'number');
    assert.ok(Array.isArray(links.data.accounts));
    const minted = await Connect.gameToken('123', { token: 'bearer-x' });
    assert.equal(minted.status, 200);
    // The API returns the token; hiding it is the CLI's job (checked in tools).
    assert.equal(minted.data.token, 'player-token');
    assert.deepEqual(printed, []);
  } finally {
    console.log = originalLog;
  }
});

test('validation rejects empty e-mail, malformed PIN and empty bind token', async () => {
  await assert.rejects(Connect.requestPin(''), /e-mail/);
  await assert.rejects(Connect.requestPin('user.example.com'), /e-mail/);
  await assert.rejects(Connect.confirmPin('a@b.c', '12a'), /PIN/);
  await assert.rejects(Connect.confirmPin('a@b.c', '123'), /PIN/);
  await assert.rejects(Connect.bind(''), /bind-token/);
  await assert.rejects(Connect.unbind(''), /bind-token/);
  await assert.rejects(Connect.bind(buildJwt(), { stateFile: path.join(tmpRoot, 'empty.json') }), /bearer/);
  await assert.rejects(Connect.unbind(buildJwt(), { stateFile: path.join(tmpRoot, 'empty.json') }), /bearer/);
});

test('LoginOk modern payload exposes the bind token and persists it', () => {
  logs.length = 0;
  const jwt = buildJwt();
  const message = new LoginOkMessage();
  message.ByteStream.set(modernPayload(jwt));
  message.decode();
  assert.equal(message.parsed, true);
  assert.equal(message.layout, 'modern-generic');
  assert.equal(message.bindToken, jwt);
  // Раскладка nulls-69 пробуется первой и на modern-пакете падает — это ожидаемо.
  assert.ok(!message.decodeErrors.some((item) => item.layout === 'modern-generic'));
  assert.equal(message.bindClaims.game, 'laser');
  assert.equal(message.bindClaims.pid, 123);

  const { account, saved, loggedIn } = processMessage(message);
  assert.equal(account.passToken, 'session-token');
  assert.equal(account.bindToken.token, jwt);
  assert.equal(typeof account.bindToken.at, 'string');
  assert.equal(saved, 1);
  assert.equal(loggedIn, 1);
  assert.ok(!logs.join('\n').includes(jwt));
});

test('LoginOk legacy payload also finds a trailing bind token', () => {
  const jwt = buildJwt();
  const message = new LoginOkMessage();
  message.ByteStream.set(legacyPayload(jwt));
  message.decode();
  assert.equal(message.layout, 'legacy');
  assert.equal(message.bindToken, jwt);
  const { account } = processMessage(message);
  assert.equal(account.bindToken.token, jwt);
});

test('LoginOk without a JWT leaves bindToken undefined and decode errors do not break process', () => {
  const plain = new LoginOkMessage();
  plain.ByteStream.set(modernPayload(null));
  plain.decode();
  assert.equal(plain.parsed, true);
  assert.equal(plain.bindToken, undefined);
  assert.ok(!plain.decodeErrors.some((item) => item.layout === 'modern-generic'));
  assert.equal(processMessage(plain).loggedIn, 1);

  const broken = new LoginOkMessage();
  broken.ByteStream.set(Buffer.from([0xff]));
  broken.decode();
  assert.equal(broken.parsed, false);
  assert.equal(broken.decodeErrors.length, 3);
  assert.deepEqual(
    broken.decodeErrors.map((item) => item.layout),
    ['nulls-69', 'modern-generic', 'legacy'],
  );
  const { saved, loggedIn } = processMessage(broken);
  assert.equal(saved, 0);
  assert.equal(loggedIn, 1);
});

test('tools/connect.js принимает голый --json и печатает одну строку', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nulls-connect-cli-'));
  try {
    const output = execFileSync(
      process.execPath,
      [path.join(__dirname, '..', 'tools', 'connect.js'), 'status', '--json'],
      {
        encoding: 'utf8',
        env: { ...process.env, NC_STATE_FILE: path.join(dir, 'connect.json') },
        timeout: 10000,
      },
    );
    const parsed = JSON.parse(output.trim());
    assert.equal(parsed.ok, true);
    assert.equal(typeof parsed.result.hasToken, 'boolean');
    assert.equal(output.trim().split('\n').length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
