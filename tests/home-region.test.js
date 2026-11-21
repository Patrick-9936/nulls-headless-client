const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const HomeRegion = require('../lib/HomeRegion');

const ANCHOR = Buffer.from('0000000000000090067f000000011000', 'hex');
const FIXTURES = path.join(__dirname, 'fixtures');

// Собирает пару «u32 длина, страна, u32 длина, хост» так, как она лежит в Home.
function pair(country, host) {
  const code = Buffer.from(country, 'ascii');
  const domain = Buffer.from(host, 'ascii');
  const result = Buffer.alloc(4 + code.length + 4 + domain.length);
  result.writeUInt32BE(code.length, 0);
  code.copy(result, 4);
  result.writeUInt32BE(domain.length, 4 + code.length);
  domain.copy(result, 8 + code.length);
  return result;
}

function anchored(country, host, before = Buffer.alloc(0), after = Buffer.alloc(0)) {
  return Buffer.concat([before, ANCHOR, pair(country, host), after]);
}

test('якорь: пара читается сразу за маркером', () => {
  const before = Buffer.from('TID_SHOP_OFFER_TITLE_40', 'ascii');
  const buffer = anchored('KZ', 'nulls.gg', before, Buffer.from([1, 2, 3]));
  const result = HomeRegion(buffer);
  assert.equal(result.country, 'KZ');
  assert.equal(result.host, 'nulls.gg');
  assert.equal(result.offset, before.length + ANCHOR.length);
  assert.equal(result.method, 'anchor');
});

test('якорь: RU/US/KE и разные длины хоста', () => {
  for (const [country, host] of [
    ['RU', 'nulls.gg'],
    ['US', 'cdn.example.com'],
    ['KE', 'a.b'],
  ]) {
    const result = HomeRegion(anchored(country, host));
    assert.equal(result.country, country);
    assert.equal(result.host, host);
    assert.equal(result.method, 'anchor');
  }
});

test('якорь: 255 байт хоста принимается, 256 — нет', () => {
  const label = 'a'.repeat(63);
  const host255 = [label, label, label, label].join('.');
  assert.equal(host255.length, 255);
  assert.equal(HomeRegion(anchored('KZ', host255)).method, 'anchor');
  assert.equal(HomeRegion(anchored('KZ', `${host255}a`)), null);
});

test('скан: без якоря пара находится старым проходом', () => {
  const noise = Buffer.from('no anchor here, just bytes', 'ascii');
  const result = HomeRegion(Buffer.concat([noise, pair('KZ', 'nulls.gg')]));
  assert.equal(result.country, 'KZ');
  assert.equal(result.host, 'nulls.gg');
  assert.equal(result.offset, noise.length);
  assert.equal(result.method, 'scan');
});

test('якорь важнее более раннего кандидата', () => {
  const decoy = pair('US', 'evil.gg');
  const buffer = Buffer.concat([decoy, Buffer.alloc(4), anchored('KZ', 'nulls.gg')]);
  const result = HomeRegion(buffer);
  assert.equal(result.method, 'anchor');
  assert.equal(result.country, 'KZ');
  assert.equal(result.host, 'nulls.gg');
});

test('мусор и пустой буфер дают null', () => {
  assert.equal(HomeRegion(null), null);
  assert.equal(HomeRegion(Buffer.alloc(0)), null);
  assert.equal(HomeRegion(Buffer.from('random bytes without a home pair')), null);
  assert.equal(HomeRegion(Buffer.alloc(2048, 0x7f)), null);
});

test('обрыв буфера и длина хоста больше остатка дают null', () => {
  const record = pair('KZ', 'nulls.gg');
  for (const cut of [0, 1, 3, 4, 5, 6, 9, 10, record.length - 1]) {
    assert.equal(HomeRegion(Buffer.concat([ANCHOR, record.subarray(0, cut)])), null, `cut=${cut}`);
  }
  const lengthOverflow = Buffer.concat([
    ANCHOR,
    Buffer.from('00000002', 'hex'),
    Buffer.from('KZ', 'ascii'),
    Buffer.alloc(4),
  ]);
  lengthOverflow.writeUInt32BE(32, ANCHOR.length + 6);
  assert.equal(HomeRegion(lengthOverflow), null);
});

test('код страны: только две заглавные латинские буквы', () => {
  for (const country of ['KZ', 'US', 'KE']) assert.equal(HomeRegion(anchored(country, 'nulls.gg')).country, country);
  for (const country of ['kz', 'K1', 'K-', 'K']) assert.equal(HomeRegion(anchored(country, 'nulls.gg')), null, country);
  // Три буквы не проходят уже на длине строки: u32 должен быть равен 2.
  assert.equal(HomeRegion(anchored('USA', 'nulls.gg')), null);
});

test('хост: точка, ASCII без пробелов, не короче 3 и не длиннее 255', () => {
  for (const [host, ok] of [
    ['nulls.gg', true],
    ['a.b', true],
    ['localhost', false],
    ['null s.gg', false],
    ['..', false],
    ['a..b', false],
    ['a', false],
    ['-a.gg', false],
  ])
    assert.equal(HomeRegion(anchored('KZ', host)) !== null, ok, host);
});

test('блок возраста не выглядит как страна', () => {
  const pending = fs.readFileSync(path.join(FIXTURES, 'home-age-pending.bin'));
  const adult = fs.readFileSync(path.join(FIXTURES, 'home-age-adult.bin'));
  assert.equal(HomeRegion(pending), null);
  assert.equal(HomeRegion(adult), null);
  // Похожий префикс: u32 2, KZ, затем не длина хоста, а 0xffffffff и мусор.
  const ageLike = Buffer.concat([Buffer.from('000000024b5affffffff14020f1e', 'hex'), Buffer.alloc(32, 0x41)]);
  assert.equal(HomeRegion(ageLike), null);
});

test('скан не перебирает бесконечно: лимит кандидатов', () => {
  const flood = [];
  for (let i = 0; i < 70; i += 1) flood.push(Buffer.from('00000002', 'hex'), Buffer.alloc(8, 0x41));
  flood.push(pair('KZ', 'nulls.gg'));
  assert.equal(HomeRegion(Buffer.concat(flood)), null);
});

test('живые обезличенные фрагменты Home читаются по якорю', () => {
  for (const [file, country] of [
    ['home-region-live-kz.bin', 'KZ'],
    ['home-region-live-us.bin', 'US'],
  ]) {
    const buffer = fs.readFileSync(path.join(FIXTURES, file));
    const result = HomeRegion(buffer);
    assert.equal(result.country, country);
    assert.equal(result.host, 'nulls.gg');
    assert.equal(result.offset, 32);
    assert.equal(result.method, 'anchor');
  }
});

test('совместимость с вызывающим кодом: .country как раньше', () => {
  assert.equal(HomeRegion(anchored('RU', 'nulls.gg')).country, 'RU');
  assert.equal(HomeRegion(Buffer.from('nope')), null);
});
