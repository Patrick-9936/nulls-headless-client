const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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
  assert.deepEqual(message.decodeErrors, []);
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
  assert.deepEqual(plain.decodeErrors, []);
  assert.equal(processMessage(plain).loggedIn, 1);

  const broken = new LoginOkMessage();
  broken.ByteStream.set(Buffer.from([0xff]));
  broken.decode();
  assert.equal(broken.parsed, false);
  assert.equal(broken.decodeErrors.length, 2);
  assert.deepEqual(
    broken.decodeErrors.map((item) => item.layout),
    ['modern-generic', 'legacy'],
  );
  const { saved, loggedIn } = processMessage(broken);
  assert.equal(saved, 0);
  assert.equal(loggedIn, 1);
});
