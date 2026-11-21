const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { EventEmitter } = require('node:events');
const Fleet = require('../lib/Fleet'),
  Store = require('../lib/Store'),
  Accounts = require('../lib/Accounts'),
  Actions = require('../lib/Actions');
const { rotateLog } = require('../tools/fleet');
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
      'metrics',
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
class AccountClient extends FakeClient {
  async connect() {
    this.account = Store.read(path.join(this.options.root, this.options.account), {});
    this.emit('account', this.account);
    return super.connect();
  }
}
test('metrics появляются в статусе и считаются', async () => {
  const root = tempRoot();
  writeAccount(root, 1);
  writeAccount(root, 2);
  const fleet = new Fleet(root, { count: 2, concurrency: 2 }, FakeClient);
  try {
    fleet.start();
    for (let i = 0; i < 20; i++) await flush();
    fleet.flushStatus(true);
    const { metrics } = Store.read(path.join(root, 'fleet-status.json'));
    assert.match(metrics.startedAt, /^\d{4}-\d\d-\d\dT/);
    assert.ok(metrics.uptimeSec >= 0);
    assert.equal(metrics.totalBots, 2);
    assert.equal(metrics.registered, 2);
    assert.equal(metrics.online, 2);
    assert.equal(metrics.loggedInTotal, 2);
    assert.equal(metrics.failedTotal, 0);
    assert.equal(typeof metrics.avgLoginMs, 'number');
    assert.equal(typeof metrics.p95LoginMs, 'number');
    assert.equal(metrics.avgRttMs, null, 'клиент не сообщает RTT');
    assert.deepEqual(metrics.commands, { ok: 0, error: 0, pending: 0 });
    assert.equal(metrics.lastCommandAt, null);
  } finally {
    fleet.stop();
    clean(root);
  }
});
test('metrics считают выполненные команды', async () => {
  const root = tempRoot(),
    fleet = new Fleet(root, { count: 1, commandScanInterval: 0 }),
    original = Actions.execute,
    id = '22223333-4444-5555-6666-777788889999';
  fleet.slots[0].status = 'online';
  fleet.clients.set(1, { state: 'online', index: 1, close() {} });
  Actions.execute = async () => ({ confirmed: true });
  try {
    Store.write(path.join(fleet.commandDir, `${id}.json`), { bot: 1, action: 'friends', args: {} });
    await fleet.processCommands();
    fleet.flushStatus(true);
    const { metrics } = Store.read(path.join(root, 'fleet-status.json'));
    assert.deepEqual(metrics.commands, { ok: 1, error: 0, pending: 0 });
    assert.match(metrics.lastCommandAt, /^\d{4}-\d\d-\d\dT/);
  } finally {
    Actions.execute = original;
    fleet.stop();
    clean(root);
  }
});
test('реестр аккаунтов обновляется после входа', async () => {
  const root = tempRoot();
  writeAccount(root, 1, { name: 'First' });
  const fleet = new Fleet(root, { count: 1 }, AccountClient);
  try {
    fleet.start();
    for (let i = 0; i < 20; i++) await flush();
    const registry = Store.read(path.join(root, 'accounts', 'index.json'));
    assert.equal(registry.version, 1);
    assert.equal(registry.accounts.length, 1);
    assert.equal(registry.accounts[0].file, 'bot-1.json');
    assert.equal(registry.accounts[0].index, 1);
    assert.equal(registry.accounts[0].hasToken, true);
    assert.equal(registry.accounts[0].name, 'First');
  } finally {
    fleet.stop();
    clean(root);
  }
});
test('ошибка реестра не роняет флот и логируется один раз', async () => {
  const root = tempRoot(),
    original = Accounts.upsert,
    previous = global.Debugger,
    warnings = [];
  writeAccount(root, 1);
  Accounts.upsert = () => {
    throw new Error('диск переполнен');
  };
  global.Debugger = { info() {}, warn: (...args) => warnings.push(args.join(' ')), error() {} };
  const fleet = new Fleet(root, { count: 1 }, AccountClient);
  try {
    fleet.start();
    for (let i = 0; i < 20; i++) await flush();
    assert.equal(fleet.slots[0].status, 'online');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /диск переполнен/);
    fleet.flushStatus(true);
    assert.equal(Store.read(path.join(root, 'fleet-status.json')).states.online, 1);
  } finally {
    Accounts.upsert = original;
    global.Debugger = previous;
    fleet.stop();
    clean(root);
  }
});
test('один сбой бота считается в failedTotal ровно один раз', async () => {
  const root = tempRoot();
  writeAccount(root, 1);
  class FailingClient extends FakeClient {
    async connect() {
      // Как настоящий клиент: сначала состояние failed, затем close → stopped, затем reject.
      this.emit('state', { state: 'failed', error: 'сервер недоступен' });
      this.emit('state', { state: 'stopped' });
      throw new Error('сервер недоступен');
    }
  }
  const fleet = new Fleet(root, { count: 1 }, FailingClient);
  try {
    fleet.start();
    for (let i = 0; i < 10; i++) await flush();
    assert.equal(fleet.slots[0].status, 'failed');
    assert.equal(fleet.metrics.failedTotal, 1, 'один инцидент — один переход в failed');
  } finally {
    fleet.stop();
    clean(root);
  }
});

test('повторный запуск после online — это новый инцидент для failedTotal', async () => {
  const root = tempRoot();
  writeAccount(root, 1);
  class FlipClient extends FakeClient {
    async connect() {
      this.emit('state', { state: 'online' });
      this.emit('online');
      this.emit('state', { state: 'failed', error: 'обрыв' });
      throw new Error('обрыв');
    }
  }
  const fleet = new Fleet(root, { count: 1 }, FlipClient);
  try {
    fleet.start();
    for (let i = 0; i < 10; i++) await flush();
    assert.equal(fleet.metrics.failedTotal, 1);
  } finally {
    fleet.stop();
    clean(root);
  }
});

test('stop() сохраняет отложенную запись реестра аккаунтов', () => {
  const root = tempRoot();
  writeAccount(root, 1);
  try {
    Accounts.refresh(root);
    const fleet = new Fleet(root, { count: 1 });
    // Первый upsert пишется сразу и открывает 5-секундное окно; второй — уже отложенный.
    Accounts.upsert(root, { passToken: 'test-token', hi: 0, lo: 101, name: 'Раннее' }, 'accounts/bot-1.json');
    Accounts.upsert(
      root,
      { passToken: 'test-token', hi: 0, lo: 101, name: 'После входа', club: '#LATE' },
      'accounts/bot-1.json',
    );
    assert.equal(
      JSON.parse(fs.readFileSync(Accounts.registryPath(root), 'utf8')).accounts.find((entry) => entry.index === 1).name,
      'Раннее',
      'второй upsert ещё не должен попасть в индекс',
    );
    fleet.stop();
    const stored = JSON.parse(fs.readFileSync(Accounts.registryPath(root), 'utf8'));
    const entry = stored.accounts.find((item) => item.index === 1);
    assert.equal(entry.name, 'После входа');
    assert.equal(entry.club, '#LATE');
  } finally {
    clean(root);
  }
});

test('processCommands пересоздаёт удалённый каталог команд', async () => {
  const root = tempRoot(),
    fleet = new Fleet(root, { count: 1, commandScanInterval: 0 });
  try {
    fs.rmSync(fleet.commandDir, { recursive: true, force: true });
    await fleet.processCommands();
    assert.equal(fs.existsSync(fleet.commandDir), true, 'каталог восстановлен');
    assert.equal(fleet.metrics.commandError, 0);
  } finally {
    fleet.stop();
    clean(root);
  }
});

test('rotateLog переносит переросший лог в .1 и удаляет самый старый', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nulls-log-')),
    file = path.join(dir, 'fleet.log');
  try {
    fs.writeFileSync(file, 'x'.repeat(2048));
    assert.equal(rotateLog(file, { maxBytes: 1024, keep: 2 }), true);
    assert.equal(fs.existsSync(file), false);
    assert.equal(fs.statSync(`${file}.1`).size, 2048);
    fs.writeFileSync(file, 'y'.repeat(2048));
    assert.equal(rotateLog(file, { maxBytes: 1024, keep: 2 }), true);
    assert.ok(fs.existsSync(`${file}.1`));
    assert.ok(fs.existsSync(`${file}.2`));
    assert.equal(fs.existsSync(`${file}.3`), false);
    assert.equal(fs.readFileSync(`${file}.2`, 'utf8').length, 2048);
    fs.writeFileSync(file, 'z');
    assert.equal(rotateLog(file, { maxBytes: 1024, keep: 2 }), false, 'маленький лог не ротируется');
    assert.equal(fs.readFileSync(file, 'utf8'), 'z');
  } finally {
    clean(dir);
  }
});
test('cleanup удаляет старый результат и не трогает свежий', () => {
  const root = tempRoot(),
    results = path.join(root, '.runtime', 'results'),
    old = path.join(results, 'aaaaaaaa-bbbb-cccc-dddd-eeeeffff0000.json'),
    fresh = path.join(results, '11111111-2222-3333-4444-555566667777.json');
  fs.mkdirSync(results, { recursive: true });
  fs.writeFileSync(old, '{}');
  fs.writeFileSync(fresh, '{}');
  const oldDate = new Date(Date.now() - 2 * 3600000);
  fs.utimesSync(old, oldDate, oldDate);
  try {
    const report = Accounts.cleanup(root);
    assert.deepEqual(report.results, [path.basename(old)]);
    assert.equal(fs.existsSync(old), false);
    assert.equal(fs.existsSync(fresh), true);
  } finally {
    clean(root);
  }
});
test('metrics.avgRttMs собирается из онлайн-слотов с измеренным RTT', async () => {
  const root = tempRoot();
  writeAccount(root, 1);
  writeAccount(root, 2);
  class RttClient extends FakeClient {
    async connect() {
      this.rttMs = 42;
      this.rttSamples = 3;
      const result = await super.connect();
      this.emit('packet', { type: 9999, payload: Buffer.alloc(0), at: new Date().toISOString() });
      return result;
    }
  }
  const fleet = new Fleet(root, { count: 2, concurrency: 2 }, RttClient);
  try {
    fleet.start();
    for (let i = 0; i < 20; i++) await flush();
    const metrics = fleet.metricsData();
    assert.equal(metrics.avgRttMs, 42);
    assert.equal(metrics.rttSamples, 6, 'сумма замеров двух онлайн-ботов');
    for (const slot of fleet.slots) slot.status = 'failed';
    const empty = fleet.metricsData();
    assert.equal(empty.avgRttMs, null);
    assert.equal(empty.rttSamples, null);
  } finally {
    fleet.stop();
    clean(root);
  }
});
test('вход в клуб отмечает slot.joined по реальной цели, а не по функции', async () => {
  const root = tempRoot();
  writeAccount(root, 1);
  const { target } = require('../lib/Protocol');
  const clubTag = '#GL0J2CPP0';
  class Fake extends FakeClient {
    async connect() {
      this.club = target(clubTag);
      return super.connect();
    }
  }
  const fleet = new Fleet(root, { count: 1, first: 1, clubTag }, Fake);
  try {
    fleet.start();
    for (let i = 0; i < 20; i++) await flush();
    assert.equal(fleet.slots[0].status, 'online');
    assert.equal(fleet.slots[0].joined, true, 'бот уже в целевом клубе — joined должен быть true');
  } finally {
    fleet.stop();
    clean(root);
  }
});
