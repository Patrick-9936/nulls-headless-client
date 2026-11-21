const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../lib/Protocol');
const D = require('../lib/Decode');
const A = require('../lib/Actions');
const HomeRegion = require('../lib/HomeRegion');

// HomeData: u32 2, код страны, u32 длина, хост. Вокруг — мусор, как в живом пакете.
function home(country, host = 'nulls.gg', prefix = Buffer.from([0x00, 0x00, 0x02, 0x00])) {
  const body = Buffer.alloc(10 + host.length);
  body.writeUInt32BE(2, 0);
  body.write(country, 4, 'ascii');
  body.writeUInt32BE(host.length, 6);
  body.write(host, 10, 'ascii');
  return Buffer.concat([prefix, body]);
}
function fakeClient({ homeData = home('RU'), afterReconnect = null, code = 0 } = {}) {
  const calls = [];
  const client = {
    state: 'online',
    home: homeData,
    account: { hi: 0, lo: 280650486, name: 'Probe' },
    club: null,
    team: null,
    regionResult: null,
    calls,
    async request(command, args, options) {
      calls.push({ type: 'request', command, args, options });
      const ref = args.region;
      this.regionResult = { code, region: ref, at: new Date().toISOString() };
      return { command, confirmed: true, response: 24178 };
    },
    async reconnect() {
      calls.push({ type: 'reconnect' });
      if (afterReconnect) this.home = afterReconnect;
    },
  };
  return client;
}

test('12998 кодирует только DataReference класса 14: VInt класс + VInt индекс', () => {
  const kz = P.encode('account-region', { region: { class: 14, index: 125 } });
  assert.equal(kz.id, 12998);
  assert.equal(kz.version, 9);
  assert.equal(kz.payload.toString('hex'), '0ebd01');
  assert.equal(P.encode('account-region', { region: '14:249' }).payload.toString('hex'), '0eb903');
  assert.equal(P.encode('account-region', { region: { class: 14, index: 126 } }).payload.toString('hex'), '0ebe01');
  assert.throws(() => P.encode('account-region', {}), /регион/);
  assert.throws(() => P.encode('account-region', { region: '15:125' }), /класса 14/);
});

test('24178 читается как VInt код + DataReference, а не как строка', () => {
  const s = D.stream(Buffer.from('000ebd01', 'hex'));
  assert.equal(s.readVInt(), 0);
  assert.deepEqual(P.readReference(s), { class: 14, index: 125 });
  assert.equal(s.remaining(), 0);
});

test('регион выбирается по коду, индексу и отображаемому имени', async () => {
  for (const [value, index] of [
    ['KZ', 125],
    ['kz', 125],
    [125, 125],
    ['14:125', 125],
    ['Kazakhstan', 125],
    ['Kenya', 126],
  ]) {
    const client = fakeClient({ homeData: home('KZ') });
    const result = await A.execute(client, 'account-region', { region: value, verify: false });
    assert.equal(client.calls[0].args.region.index, index, String(value));
    assert.equal(client.calls[0].args.region.class, 14);
    assert.equal(result.country, index === 125 ? 'KZ' : 'KE');
    assert.deepEqual(result.region, { class: 14, index });
  }
});

test('неизвестный регион отклоняется со списком стран', async () => {
  await assert.rejects(
    () => A.execute(fakeClient(), 'account-region', { region: 'ZZ' }),
    (error) => {
      assert.match(error.message, /Неизвестный регион/);
      assert.match(error.message, /KZ/);
      assert.match(error.message, /14:N/);
      return true;
    },
  );
  await assert.rejects(() => A.execute(fakeClient(), 'account-region', {}), /Укажите регион/);
});

test('подтверждение: код 0 и та же ссылка, страна сверяется с Home', async () => {
  const client = fakeClient({ homeData: home('RU'), afterReconnect: home('KZ') });
  const result = await A.execute(client, 'account-region', { region: 'KZ' });
  assert.deepEqual(
    client.calls.map((c) => c.type),
    ['request', 'reconnect'],
  );
  assert.equal(client.calls[0].args.region.index, 125);
  assert.deepEqual(result.region, { class: 14, index: 125 });
  assert.equal(result.country, 'KZ');
  assert.equal(result.confirmed, true);
  assert.equal(result.countryVerified, true);
  assert.equal(result.homeCountry, 'KZ');
});

test('совпавший Home не требует переподключения, --no-verify его отключает', async () => {
  const current = fakeClient({ homeData: home('KZ') });
  const result = await A.execute(current, 'account-region', { region: 'KZ' });
  assert.deepEqual(
    current.calls.map((c) => c.type),
    ['request'],
  );
  assert.equal(result.countryVerified, true);
  const skipped = fakeClient({ homeData: home('RU') });
  const value = await A.execute(skipped, 'account-region', { region: 'KZ', verify: false });
  assert.equal(value.countryVerified, false);
  assert.equal(value.homeCountry, null);
});

test('постоянный бот fleet не переподключается без --verify', async () => {
  const client = fakeClient({ homeData: home('RU'), afterReconnect: home('KZ') });
  client.options = { reconnect: true };
  const result = await A.execute(client, 'account-region', { region: 'KZ' });
  assert.deepEqual(
    client.calls.map((c) => c.type),
    ['request'],
  );
  assert.equal(result.countryVerified, false);
  assert.match(result.note, /fleet/);
  const explicit = fakeClient({ homeData: home('RU'), afterReconnect: home('KZ') });
  explicit.options = { reconnect: true };
  const checked = await A.execute(explicit, 'account-region', { region: 'KZ', verify: true });
  assert.deepEqual(
    explicit.calls.map((c) => c.type),
    ['request', 'reconnect'],
  );
  assert.equal(checked.countryVerified, true);
});

test('код отказа сервера и чужой регион попадают в ошибку', async () => {
  await assert.rejects(() => A.execute(fakeClient({ code: 7 }), 'account-region', { region: 'KZ' }), /код 7/);
  const wrong = fakeClient({ homeData: home('KZ') });
  wrong.request = async () => {
    wrong.regionResult = { code: 0, region: { class: 14, index: 126 }, at: new Date().toISOString() };
    return { confirmed: true, response: 24178 };
  };
  await assert.rejects(() => A.execute(wrong, 'account-region', { region: 'KZ' }), /14:126 вместо 14:125/);
});

test('HomeRegion находит страну рядом с хостом и не путает её с возрастом', () => {
  assert.deepEqual(HomeRegion(home('KZ')), { country: 'KZ', host: 'nulls.gg', offset: 4 });
  const age = Buffer.concat([
    Buffer.from([0, 0, 0, 2]),
    Buffer.from('RU'),
    Buffer.from([0xff, 0xff, 0xff, 0xff]),
    Buffer.from([1, 15, 1]),
  ]);
  assert.equal(HomeRegion(age), null);
  assert.equal(HomeRegion(Buffer.alloc(0)), null);
});

test('create-account с --region применяет регион после входа и проверяет Home', async () => {
  const client = fakeClient({ homeData: home('RU'), afterReconnect: home('KZ') });
  const result = await A.execute(client, 'create-account', { region: 'KZ', name: 'Probe' });
  assert.deepEqual(
    client.calls.map((c) => c.type),
    ['request', 'reconnect'],
  );
  assert.equal(client.calls[0].command, 'account-region');
  assert.equal(result.command, 'create-account');
  assert.equal(result.confirmed, true);
  assert.equal(result.country, 'KZ');
  assert.equal(result.countryVerified, true);
  assert.equal(result.account.name, 'Probe');
  const plain = fakeClient();
  const login = await A.execute(plain, 'create-account', { name: 'Probe' });
  assert.deepEqual(plain.calls, []);
  assert.equal(login.confirmed, true);
});
