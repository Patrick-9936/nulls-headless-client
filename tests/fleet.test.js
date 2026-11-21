const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { EventEmitter } = require('node:events');
const Fleet = require('../lib/Fleet'),
  Store = require('../lib/Store'),
  Actions = require('../lib/Actions');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const flush = () => new Promise((resolve) => setImmediate(resolve));
const tempRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nulls-fleet-'));
const clean = (root) => fs.rmSync(root, { recursive: true, force: true });
function writeAccount(root, index, extra = {}) {
  fs.mkdirSync(path.join(root, 'accounts'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'accounts', `bot-${index}.json`),
    JSON.stringify({ passToken: 'test-token', hi: 0, lo: 100 + index, ...extra }),
  );
}
class FakeClient extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.index = options.index;
    this.state = 'queued';
    this.attempts = 1;
  }
  async connect() {
    this.state = 'online';
    this.emit('state', { state: this.state });
    this.emit('online');
    return this;
  }
  close() {
    this.state = 'stopped';
  }
}
test('100 изменений состояния дают не более пяти записей статуса за 2 с', async () => {
  const root = tempRoot(),
    fleet = new Fleet(root, { count: 3, statusInterval: 500 }),
    original = Store.write,
    writes = [];
  Store.write = (file, value) => {
    if (file.endsWith('fleet-status.json')) {
      writes.push(value);
      return undefined;
    }
    return original(file, value);
  };
  try {
    for (let i = 0; i < 100; i++) {
      fleet.slots[i % 3].status = i % 2 ? 'queued' : 'connecting';
      fleet.snapshot();
    }
    assert.equal(writes.length, 1, 'первое изменение пишется сразу');
    await sleep(2000);
    assert.ok(writes.length >= 2, `записей должно быть несколько: ${writes.length}`);
    assert.ok(writes.length <= 5, `слишком частые записи: ${writes.length}`);
  } finally {
    Store.write = original;
    fleet.stop();
    clean(root);
  }
});
test('форма и содержимое fleet-status.json не изменились', () => {
  const root = tempRoot();
  writeAccount(root, 1, { name: 'First' });
  const fleet = new Fleet(root, { count: 2, first: 1, clubTag: '#ABC' });
  try {
    fleet.paused = true;
    fleet.slots[0].status = 'online';
    fleet.flushStatus(true);
    const status = Store.read(path.join(root, 'fleet-status.json'));
    assert.deepEqual(Object.keys(status), [
      'pid',
      'updatedAt',
      'first',
      'requested',
      'clubTag',
      'states',
      'creationPaused',
      'bots',
    ]);
    assert.equal(status.pid, process.pid);
    assert.equal(status.first, 1);
    assert.equal(status.requested, 2);
    assert.equal(status.clubTag, '#ABC');
    assert.deepEqual(status.states, { online: 1, queued: 1 });
    assert.equal(status.creationPaused, 'Приостановлено командой пользователя');
    assert.equal(status.bots.length, 2);
    assert.equal(status.bots[0].index, 1);
    assert.equal(status.bots[0].registered, true);
    assert.equal(status.bots[1].registered, false);
    assert.match(status.updatedAt, /^\d{4}-\d\d-\d\dT/);
  } finally {
    fleet.stop();
    clean(root);
  }
});
test('без изменений запись пропускается, heartbeat обновляет updatedAt', async () => {
  const root = tempRoot(),
    fleet = new Fleet(root, { count: 1, statusInterval: 10, statusHeartbeat: 1000 }),
    original = Store.write;
  let writes = 0;
  Store.write = (file, value) => {
    if (file.endsWith('fleet-status.json')) {
      writes++;
      return undefined;
    }
    return original(file, value);
  };
  try {
    fleet.flushStatus(true);
    assert.equal(writes, 1);
    await sleep(200);
    fleet.snapshot();
    await sleep(100);
    assert.equal(writes, 1, 'неизменившийся статус не пишется');
    await sleep(900);
    fleet.snapshot();
    await sleep(50);
    assert.equal(writes, 2, 'heartbeat пишет статус, даже если содержимое то же');
  } finally {
    Store.write = original;
    fleet.stop();
    clean(root);
  }
});
test('курсор запускает каждого бота один раз и первыми идут зарегистрированные', async () => {
  const root = tempRoot();
  writeAccount(root, 2);
  writeAccount(root, 3);
  writeAccount(root, 4);
  const launched = [];
  class Fake extends FakeClient {
    async connect() {
      launched.push(this.options.index);
      return super.connect();
    }
  }
  const fleet = new Fleet(root, { first: 1, count: 4, concurrency: 4 }, Fake);
  try {
    fleet.start();
    for (let i = 0; i < 20; i++) await flush();
    assert.deepEqual(launched, [2, 3, 4, 1]);
    assert.equal(new Set(launched).size, 4);
    assert.equal(fleet.inflight, 0);
    assert.deepEqual(
      fleet.slots.map((slot) => slot.status),
      ['online', 'online', 'online', 'online'],
    );
  } finally {
    fleet.stop();
    clean(root);
  }
});
test('command --all выполняет 20 ботов параллельно и сохраняет порядок результатов', async () => {
  const root = tempRoot(),
    fleet = new Fleet(root, { count: 20, commandConcurrency: 8 }),
    original = Actions.execute,
    id = '11112222-3333-4444-5555-666677778888';
  for (const slot of fleet.slots) {
    slot.status = 'online';
    fleet.clients.set(slot.index, { state: 'online', index: slot.index, close() {} });
  }
  Actions.execute = async (client) => {
    await sleep(50);
    if (client.index === 7) throw new Error('отказ сервера');
    return { confirmed: true };
  };
  try {
    Store.write(path.join(fleet.commandDir, `${id}.json`), { all: true, action: 'friends', args: {} });
    const started = Date.now();
    await fleet.processCommands();
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 600, `последовательный запуск занял бы ~1000 мс, получено ${elapsed} мс`);
    const result = Store.read(path.join(root, '.runtime', 'results', `${id}.json`));
    assert.equal(result.ok, true);
    assert.deepEqual(
      result.result.map((item) => item.index),
      fleet.slots.map((slot) => slot.index),
    );
    assert.equal(result.result.find((item) => item.index === 7).error, 'отказ сервера');
    assert.ok(result.result.filter((item) => item.index !== 7).every((item) => item.confirmed));
    assert.equal(fs.existsSync(path.join(fleet.commandDir, `${id}.json`)), false);
  } finally {
    Actions.execute = original;
    fleet.stop();
    clean(root);
  }
});
test('два тика не обрабатывают один и тот же файл команды дважды', async () => {
  const root = tempRoot(),
    fleet = new Fleet(root, { count: 1, commandScanInterval: 0 }),
    original = Actions.execute,
    id = 'aaaabbbb-cccc-dddd-eeee-ffff00001111';
  let calls = 0;
  fleet.slots[0].status = 'online';
  fleet.clients.set(1, { state: 'online', index: 1, close() {} });
  Actions.execute = async () => {
    calls++;
    await sleep(30);
    return { confirmed: true };
  };
  try {
    Store.write(path.join(fleet.commandDir, `${id}.json`), { bot: 1, action: 'friends', args: {} });
    await Promise.all([fleet.processCommands(), fleet.processCommands()]);
    assert.equal(calls, 1);
    assert.equal(fs.existsSync(path.join(root, '.runtime', 'results', `${id}.json`)), true);
    assert.equal(fs.existsSync(path.join(fleet.commandDir, `${id}.processing`)), false);
  } finally {
    Actions.execute = original;
    fleet.stop();
    clean(root);
  }
});
test('stop() оставляет финальный статус со всеми stopped', () => {
  const root = tempRoot(),
    fleet = new Fleet(root, { count: 2 });
  try {
    fleet.stop();
    const status = Store.read(path.join(root, 'fleet-status.json'));
    assert.deepEqual(status.states, { stopped: 2 });
    assert.ok(status.bots.every((slot) => slot.status === 'stopped'));
  } finally {
    clean(root);
  }
});
