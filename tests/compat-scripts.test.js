// Контракт совместимости для внешних скриптов (см. docs/SCRIPTS.md).
// Скрипты пользователя лежат вне репозитория и копируются в tools/, поэтому
// они подключают модули клиента по относительным путям. Этот тест фиксирует
// минимум, который нельзя ломать без мажорной версии.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

test('lib/Args.parse принимает флаги внешних скриптов', () => {
  const { parse } = require('../lib/Args');
  const { options, positional } = parse([
    'raid',
    '--club',
    '#TAG',
    '--bots=0',
    '--concurrency',
    '40',
    '--members-only=1',
    '--direct=1',
    '--message-cycle',
    '10',
    '--dry-run',
  ]);
  assert.deepEqual(positional, ['raid']);
  assert.equal(options.club, '#TAG');
  assert.equal(options.bots, '0');
  assert.equal(options.concurrency, '40');
  assert.equal(options.membersOnly, '1');
  assert.equal(options.direct, '1');
  assert.equal(options.messageCycle, '10');
  assert.equal(options.dryRun, true);
});

test('lib/Client принимает опции внешних скриптов и остаётся EventEmitter', () => {
  const Client = require('../lib/Client');
  const client = new Client({
    root: ROOT,
    account: 'accounts/compat-fixture.json',
    name: null,
    reconnect: false,
    index: 3,
  });
  for (const method of ['connect', 'close', 'save']) assert.equal(typeof client[method], 'function', method);
  for (const event of ['state', 'online', 'warning', 'disconnected', 'account']) {
    assert.ok(client.listenerCount(event) >= 0);
  }
  assert.equal(client.root, ROOT);
});

test('lib/Actions и lib/Protocol отдают ожидаемые функции', () => {
  const Actions = require('../lib/Actions');
  const Protocol = require('../lib/Protocol');
  assert.equal(typeof Actions.execute, 'function');
  assert.ok(Array.isArray(Actions.commands) && Actions.commands.includes('login'));
  const packet = Protocol.encode('club-chat', { text: 'проверка' });
  assert.equal(typeof packet.id, 'number');
  assert.ok(Buffer.isBuffer(packet.payload) && packet.payload.length > 0);
});

test('lib/Store читает и пишет JSON атомарно', () => {
  const Store = require('../lib/Store');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nulls-store-'));
  const file = path.join(dir, 'nested', 'state.json');
  Store.write(file, { hi: 1, lo: 2 });
  assert.deepEqual(Store.read(file), { hi: 1, lo: 2 });
  assert.equal(Store.read(path.join(dir, 'missing.json'), { fallback: true }).fallback, true);
  const mode = fs.statSync(file).mode & 0o777;
  assert.equal(mode, 0o600, 'файл состояния должен быть доступен только владельцу');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('utils/TagCodec переводит тег в LogicLong и обратно', () => {
  const Tag = require('../utils/TagCodec');
  const id = Tag.tagToLogicLong('#GL0J2CPP0');
  assert.equal(typeof id.hi, 'number');
  assert.equal(typeof id.lo, 'number');
  assert.equal(Tag.logicLongToTag(id.hi, id.lo), '#GL0J2CPP0');
  assert.equal(typeof Tag.describeTag('#GL0J2CPP0'), 'object');
});

test('utils/NullsLicense.apply заполняет логин без сети', () => {
  const config = { ...JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')) };
  require('../utils/NullsLicense').apply(config, ROOT);
  assert.equal(typeof config.loginClientSeed, 'number');
  assert.equal(typeof config.createHelloExtra, 'function');
  const extra = config.createHelloExtra();
  assert.ok(Buffer.isBuffer(extra) && extra.length > 58);
});

test('ModernClientHelloMessage кодируется из config (путь club-rush.js)', () => {
  const config = { ...JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')) };
  require('../utils/NullsLicense').apply(config, ROOT);
  const Hello = require('../Messaging/Messages/Client/ModernClientHelloMessage');
  const message = new Hello(config);
  message.encode();
  const body = message.ByteStream.getBytes();
  assert.ok(Buffer.isBuffer(body) && body.length > 0);
});

test('lib/ProxySources и utils/ProxyConnect доступны как раньше', () => {
  const Sources = require('../lib/ProxySources');
  const Proxy = require('../utils/ProxyConnect');
  assert.equal(typeof Sources, 'object');
  assert.equal(typeof Proxy.parseProxy, 'function');
  assert.equal(typeof Proxy.connectSocket, 'function');
  assert.equal(Proxy.parseProxy('socks5://1.2.3.4:1080').type, 'socks5');
});

test('корневые клипы внешних скриптов на месте', () => {
  for (const file of [
    'config.json',
    'client-license.bin',
    'lib/Client.js',
    'lib/Actions.js',
    'lib/Store.js',
    'utils/TagCodec.js',
    'utils/NullsLicense.js',
    'Messaging/Messages/Client/ModernClientHelloMessage.js',
  ]) {
    assert.ok(fs.existsSync(path.join(ROOT, file)), file);
  }
});
