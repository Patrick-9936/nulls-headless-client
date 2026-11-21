const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { EventEmitter } = require('node:events');
const Client = require('../lib/Client'),
  Fleet = require('../lib/Fleet');

// Фейковый клиент без сокета: берём настоящие request/wait/_packet, подменяем только
// Messaging.send. Ответ приходит через _packet — как из socket.on('data') в жизни.
function fakeClient(onSend) {
  const client = Object.create(Client.prototype);
  EventEmitter.call(client);
  client.state = 'online';
  client.config = { packetIds: { loginFailed: -1 } };
  client.pending = new Set();
  client.rttWindow = [];
  client.rttTotalMs = 0;
  client.rttMs = null;
  client.rttSamples = 0;
  client.messaging = {
    send(type, payload, version) {
      onSend?.(client, { type, payload, version });
    },
  };
  return client;
}

const reply = (client, type, delay = 0) => setTimeout(() => client._packet(type, Buffer.alloc(0)), delay);

const tempRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nulls-rtt-'));

test('RTT измеряется от отправки до совпавшего ответа', async () => {
  const client = fakeClient((c) => reply(c, 9001, 10));
  const result = await client.request('friends', {}, { types: [9001] });
  assert.equal(result.confirmed, true);
  assert.equal(typeof client.rttMs, 'number');
  assert.ok(client.rttMs >= 0, `ожидалось неотрицательное значение: ${client.rttMs}`);
  assert.equal(client.rttSamples, 1);
});

test('окно замеров растёт и ограничено 50 последними значениями', async () => {
  const client = fakeClient((c) => setImmediate(() => c._packet(9002, Buffer.alloc(0))));
  for (let i = 0; i < 55; i++) await client.request('friends', {}, { types: [9002] });
  assert.equal(client.rttSamples, 50);
  assert.equal(client.rttWindow.length, 50);
  assert.equal(typeof client.rttMs, 'number');
  // Мгновенный ответ в той же миллисекунде даёт 0 — это валидный замер, а не «нет данных».
  assert.ok(client.rttMs >= 0);
});

test('таймаут не попадает в окно и не портит среднее', async () => {
  const client = fakeClient((c) => reply(c, 9003, 5));
  await client.request('friends', {}, { types: [9003] });
  const measured = client.rttMs;
  const samples = client.rttSamples;
  client.messaging = { send() {} };
  await assert.rejects(
    client.request('friends', {}, { types: [9999], timeout: 20 }),
    (error) => error.code === 'TIMEOUT',
  );
  assert.equal(client.rttMs, measured);
  assert.equal(client.rttSamples, samples);
});

test('отмена ожидания не считается RTT', async () => {
  const client = fakeClient(() => {});
  const waiter = client.wait([9004]);
  waiter.item.rttStart = process.hrtime.bigint();
  waiter.cancel(new Error('отменено'));
  await assert.rejects(waiter.promise, /отменено/);
  assert.equal(client.rttMs, null);
  assert.equal(client.rttSamples, 0);
});

test('пустая история замеров даёт null, а не ноль', () => {
  const client = fakeClient(() => {});
  assert.equal(client.rttMs, null);
  assert.equal(client.rttSamples, 0);
});

test('Fleet считает avgRttMs по онлайн-слотам, без данных — null', () => {
  const root = tempRoot();
  const fleet = new Fleet(root, { count: 3 });
  try {
    fleet.slots[0].status = 'online';
    fleet.slots[0].rttMs = 30;
    fleet.slots[0].rttSamples = 5;
    fleet.slots[1].status = 'online';
    fleet.slots[1].rttMs = 50;
    fleet.slots[1].rttSamples = 2;
    fleet.slots[2].status = 'failed';
    fleet.slots[2].rttMs = 900;
    fleet.slots[2].rttSamples = 9;

    const metrics = fleet.metricsData();
    assert.equal(metrics.avgRttMs, 40, 'офлайн-слот не должен влиять на среднее');
    assert.equal(metrics.rttSamples, 7);

    for (const slot of fleet.slots) slot.status = 'offline';
    const empty = fleet.metricsData();
    assert.equal(empty.avgRttMs, null);
    assert.equal(empty.rttSamples, null);
  } finally {
    fleet.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
