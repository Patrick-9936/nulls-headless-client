// Интеграция флота: Fleet + фейковый ClientType + реестр Accounts + кадр watch.
// Сеть не используется, каталог — только os.tmpdir().
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const Fleet = require('../lib/Fleet');
const Store = require('../lib/Store');
const Accounts = require('../lib/Accounts');
const Actions = require('../lib/Actions');
const watch = require('../tools/watch');
const I18N = require('../lib/i18n');
const { rotateLog, FleetLog, logOptions } = require('../tools/fleet');

I18N.setLanguage('ru');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tempRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nulls-int-fleet-'));
const clean = (root) => fs.rmSync(root, { recursive: true, force: true });

function writeAccount(root, index, extra = {}) {
  fs.mkdirSync(path.join(root, 'accounts'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'accounts', `bot-${index}.json`),
    JSON.stringify({ passToken: `test-token-${index}`, hi: 0, lo: 100 + index, ...extra }),
  );
}

// Читает свой файл, как настоящий Client после LoginOk, и сообщает account.
class FakeClient extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.index = options.index;
    this.file = path.join(options.root, options.account);
    this.state = 'queued';
    this.attempts = 1;
  }
  async connect() {
    await sleep(5); // чтобы avgLoginMs был строго больше нуля
    this.account = Store.read(this.file, {});
    this.emit('account', this.account);
    this.state = 'online';
    this.emit('state', { state: 'online' });
    this.emit('online');
    return this;
  }
  close() {
    this.state = 'stopped';
  }
}

async function waitFor(predicate, timeout = 2000) {
  const deadline = Date.now() + timeout;
  while (!predicate() && Date.now() < deadline) await sleep(10);
  return predicate();
}

test('5 ботов доходят до online: metrics, реестр и кадр watch согласованы', async () => {
  const root = tempRoot();
  const upserted = [];
  const originalUpsert = Accounts.upsert;
  Accounts.upsert = (dir, account, file) => {
    upserted.push(path.basename(String(file)));
    return originalUpsert(dir, account, file);
  };
  for (let index = 1; index <= 5; index++) writeAccount(root, index, { name: `Bot ${index}` });
  const fleet = new Fleet(root, { first: 1, count: 5, concurrency: 5, statusInterval: 0 }, FakeClient);
  try {
    fleet.start();
    const online = await waitFor(() => fleet.inflight === 0 && fleet.slots.every((slot) => slot.status === 'online'));
    assert.equal(online, true, JSON.stringify(fleet.slots));
    fleet.flushStatus(true);

    const status = Store.read(path.join(root, 'fleet-status.json'));
    assert.equal(status.states.online, 5);
    assert.equal(status.metrics.online, 5);
    assert.equal(status.metrics.loggedInTotal, 5);
    assert.equal(status.metrics.failedTotal, 0);
    assert.ok(status.metrics.avgLoginMs > 0, `avgLoginMs=${status.metrics.avgLoginMs}`);
    assert.deepEqual(status.metrics.commands, { ok: 0, error: 0, pending: 0 });

    // Реестр — производный индекс: первый upsert пересобирает скан всех файлов.
    const registry = Store.read(Accounts.registryPath(root));
    assert.equal(registry.version, Accounts.VERSION);
    assert.deepEqual(
      registry.accounts.map((entry) => entry.index),
      [1, 2, 3, 4, 5],
    );
    assert.ok(registry.accounts.every((entry) => entry.hasToken === true));
    assert.deepEqual(
      registry.accounts.map((entry) => entry.name),
      ['Bot 1', 'Bot 2', 'Bot 3', 'Bot 4', 'Bot 5'],
    );
    assert.deepEqual([...new Set(upserted)].sort(), [
      'bot-1.json',
      'bot-2.json',
      'bot-3.json',
      'bot-4.json',
      'bot-5.json',
    ]);

    const frame = watch.collectFrame({ root, width: 100 });
    assert.equal(frame.online, 5);
    assert.equal(frame.total, 5);
    assert.ok(frame.metrics.loginMs > 0, `watch loginMs=${frame.metrics.loginMs}`);
    assert.equal(frame.registry.present, true);
    assert.equal(frame.registry.count, 5);
    const text = watch.renderFrame(frame);
    assert.match(text, /онлайн 5 из 5/);
    assert.match(text, /Bot 1/);
    assert.match(text, /реестр аккаунтов: 5/);
  } finally {
    Accounts.upsert = originalUpsert;
    fleet.stop();
    clean(root);
  }
});

test('command --all пишет результаты в .runtime/results и растит commands.ok', async () => {
  const root = tempRoot();
  const fleet = new Fleet(root, { count: 5, commandScanInterval: 0 });
  const originalExecute = Actions.execute;
  const id = '11112222-3333-4444-5555-666677778888';
  for (const slot of fleet.slots) {
    slot.status = 'online';
    fleet.clients.set(slot.index, { state: 'online', index: slot.index, close() {} });
  }
  Actions.execute = async (client) => ({ confirmed: true, index: client.index });
  try {
    Store.write(path.join(fleet.commandDir, `${id}.json`), { all: true, action: 'friends', args: {} });
    await fleet.processCommands();

    const resultFile = path.join(root, '.runtime', 'results', `${id}.json`);
    assert.equal(fs.existsSync(resultFile), true);
    const result = Store.read(resultFile);
    assert.equal(result.ok, true);
    assert.deepEqual(
      result.result.map((item) => item.index),
      [1, 2, 3, 4, 5],
    );
    assert.ok(result.result.every((item) => item.confirmed === true));
    assert.equal(fs.existsSync(path.join(fleet.commandDir, `${id}.json`)), false);

    fleet.flushStatus(true);
    const status = Store.read(path.join(root, 'fleet-status.json'));
    assert.equal(status.metrics.commands.ok, 1);
    assert.equal(status.metrics.commands.error, 0);
    assert.match(status.metrics.lastCommandAt, /^\d{4}-\d\d-\d\dT/);
  } finally {
    Actions.execute = originalExecute;
    fleet.stop();
    clean(root);
  }
});

test('флот ротирует fleet.log по --log-max-bytes в .1 и продолжает писать', () => {
  const root = tempRoot();
  const file = path.join(root, 'fleet.log');
  const log = new FleetLog(file, { maxBytes: 1024, keep: 2 });
  try {
    fs.writeFileSync(file, 'x'.repeat(4096));
    assert.equal(log.rotateIfNeeded(), true);
    assert.equal(fs.existsSync(`${file}.1`), true);
    assert.equal(fs.statSync(`${file}.1`).size, 4096);
    assert.equal(fs.statSync(file).size, 0, 'после ротации открывается новый пустой файл');
    log.write('после ротации\n');
    log.close();
    assert.match(fs.readFileSync(file, 'utf8'), /после ротации/);

    // Прямой вызов rotateLog: маленький файл не трогается, maxBytes ниже 1024 — зажим.
    assert.equal(rotateLog(file, { maxBytes: 1024 }), false);
    assert.equal(logOptions({ maxBytes: 10 }).maxBytes, 5 * 1024 * 1024);
  } finally {
    log.close();
    clean(root);
  }
});

test('cleanup удаляет старый результат, но не свежий и не аккаунт с токеном', () => {
  const root = tempRoot();
  const results = path.join(root, '.runtime', 'results');
  fs.mkdirSync(results, { recursive: true });
  const oldName = 'aaaaaaaa-bbbb-cccc-dddd-eeeeffff0000.json';
  const freshName = '11111111-2222-3333-4444-555566667777.json';
  const old = path.join(results, oldName);
  const fresh = path.join(results, freshName);
  fs.writeFileSync(old, '{"ok":true}');
  fs.writeFileSync(fresh, '{"ok":true}');
  const twoHoursAgo = new Date(Date.now() - 2 * 3600000);
  fs.utimesSync(old, twoHoursAgo, twoHoursAgo);
  writeAccount(root, 1, { name: 'Keep' });
  const accountFile = path.join(root, 'accounts', 'bot-1.json');
  try {
    const report = Accounts.cleanup(root);
    assert.deepEqual(report.results, [oldName]);
    assert.equal(fs.existsSync(old), false);
    assert.equal(fs.existsSync(fresh), true);
    assert.equal(fs.existsSync(accountFile), true);
    assert.equal(Store.read(accountFile).passToken, 'test-token-1');
  } finally {
    clean(root);
  }
});
