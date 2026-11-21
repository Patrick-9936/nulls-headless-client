// LoginOk на Nulls 69.252: раскладка снята с живого сервера, JWT-токен
// Nulls Connect лежит в zlib-потоке в конце пакета. Фикстура обезличена:
// структура и смещения настоящие, токен синтетический.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const ByteStream = require('../DataStream/ByteStream');
const LoginOkMessage = require('../Messaging/Messages/Server/LoginOkMessage');

const FIXTURES = path.join(__dirname, 'fixtures');

function decode(name) {
  const message = new LoginOkMessage();
  message.ByteStream.set(fs.readFileSync(path.join(FIXTURES, name)));
  message.decode();
  return message;
}

test('живой LoginOk 69.252 разбирается по точной раскладке', () => {
  const message = decode('login-ok-69.bin');
  assert.equal(message.layout, 'nulls-69');
  assert.deepEqual(message.decodeErrors, []);
  assert.equal(message.hi, 0);
  assert.equal(message.lo, 280648723);
  assert.equal(message.homeHi, 0);
  assert.equal(message.homeLo, 280648723);
  assert.equal(message.token, 'jpF6veey1+CHayqfy9/q');
  assert.equal(message.clientMajor, 69);
  assert.equal(message.contentVersion, 414);
  assert.equal(message.environment, 'prod');
  assert.equal(message.buildTag, '103121310241222');
  assert.equal(message.countryCode, 'RU');
  assert.deepEqual(message.patchUrls, ['https://watt.yellowwarmsand.com/patch-bs', 'http://45.95.201.23/patch-bs']);
  assert.deepEqual(message.eventUrls, ['https://watt.yellowwarmsand.com/events-bs', 'http://45.95.201.23/events-bs']);
  assert.deepEqual(message.optionalStrings, [null, null]);
  // Хвост «сжатая строка»: VInt mode, int32 BE длина blob, blob = u32 LE
  // длина JWT + zlib-поток (см. декодер LoginOk в libg.so по 0xf2cd80).
  assert.equal(message.tokenBlobMode, 0);
  assert.equal(message.tokenBlobLength, 159);
  assert.equal(message.tokenRawLength, 165);
  assert.equal(message.tokenInflatedLength, 165);
});

test('bind-токен извлекается из zlib-хвоста вместе с claims', () => {
  const message = decode('login-ok-69.bin');
  assert.match(message.bindToken, /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.equal(message.bindClaims.game, 'laser');
  assert.equal(message.bindClaims.bind, true);
  assert.equal(message.bindClaims.pid, '123456789');
  assert.equal(message.bindClaims.exp, 1893456000);
  assert.deepEqual(message.bindFrame, { offset: 4, blob: 159, compressed: 155, raw: 165 });
});

test('длины хвоста читаются из пакета, а не угадываются', () => {
  // Собираем пакет с другим по длине (синтетическим) JWT и пересчитываем
  // int32-длину blob и u32 LE длину распаковки — парсер обязан взять обе.
  const source = fs.readFileSync(path.join(FIXTURES, 'login-ok-69.bin'));
  const header = source.subarray(0, 315);
  const payload = Buffer.from(
    'eyJhbGciOiJIUzI1NiJ9.' + Buffer.from('{"game":"laser","bind":true,"pid":"1"}').toString('base64url') + '.c2ln',
  );
  const stream = zlib.deflateSync(payload);
  const tail = Buffer.alloc(9);
  tail[0] = 0;
  tail.writeInt32BE(4 + stream.length, 1);
  tail.writeUInt32LE(payload.length, 5);
  const message = new LoginOkMessage();
  message.ByteStream.set(Buffer.concat([header, tail, stream]));
  message.decode();
  assert.equal(message.layout, 'nulls-69');
  assert.equal(message.tokenBlobMode, 0);
  assert.equal(message.tokenBlobLength, 4 + stream.length);
  assert.equal(message.tokenRawLength, payload.length);
  assert.equal(message.tokenInflatedLength, payload.length);
  assert.equal(message.bindToken, payload.toString());
});

test('пакет без хвоста разбирается, но токена не даёт', () => {
  const message = decode('login-ok-69-no-token.bin');
  assert.equal(message.layout, 'nulls-69');
  assert.equal(message.parsed, true);
  assert.equal(message.bindToken, undefined);
  assert.equal(message.lo, 280648723);
});

test('битый zlib-хвост не ломает разбор и не подсовывает токен', () => {
  const bytes = Buffer.from(fs.readFileSync(path.join(FIXTURES, 'login-ok-69.bin')));
  bytes.fill(0x2a, 328); // 328 — начало zlib-потока внутри blob
  const message = new LoginOkMessage();
  message.ByteStream.set(bytes);
  message.decode();
  assert.equal(message.layout, 'nulls-69');
  assert.equal(message.bindToken, undefined);
});

test('обрезанный пакет не считается разобранным', () => {
  const bytes = fs.readFileSync(path.join(FIXTURES, 'login-ok-69.bin')).subarray(0, 8);
  const message = new LoginOkMessage();
  message.ByteStream.set(bytes);
  message.decode();
  assert.equal(message.parsed, false);
  assert.ok(message.decodeErrors.length >= 1);
});

test('process сохраняет bind-токен и не печатает его в лог', () => {
  const message = decode('login-ok-69.bin');
  const logged = [];
  const previous = global.Debugger;
  global.Debugger = { info: (...args) => logged.push(args.join(' ')), warn() {}, error() {} };
  try {
    const account = {};
    let loggedIn = false;
    message.process({
      account,
      saveAccount() {},
      onLoggedIn() {
        loggedIn = true;
      },
    });
    assert.equal(loggedIn, true);
    assert.equal(account.passToken, 'jpF6veey1+CHayqfy9/q');
    assert.equal(account.bindToken.token, message.bindToken);
    assert.ok(!logged.join('\n').includes(message.bindToken), 'сам токен не должен попадать в лог');
  } finally {
    global.Debugger = previous;
  }
});
