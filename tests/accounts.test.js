const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const Accounts = require('../lib/Accounts'),
  TagCodec = require('../utils/TagCodec');
const tempRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nulls-accounts-'));
const clean = (root) => fs.rmSync(root, { recursive: true, force: true });
function writeAccount(root, index, value = {}) {
  fs.mkdirSync(path.join(root, 'accounts'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'accounts', `bot-${index}.json`),
    JSON.stringify({ passToken: 'test-token', hi: 0, lo: 100 + index, ...value }),
  );
}
function registry(root) {
  return JSON.parse(fs.readFileSync(Accounts.registryPath(root), 'utf8'));
}
test('scan читает accounts/*.json, сортирует и не падает на битом файле', () => {
  const root = tempRoot();
  writeAccount(root, 2, { name: 'Second', club: '#TEAM2' });
  writeAccount(root, 1, { name: 'First' });
  fs.writeFileSync(path.join(root, 'accounts', 'bot-3.json'), '{"hi": 0,');
  fs.writeFileSync(path.join(root, 'accounts', 'notes.json'), JSON.stringify({ hi: 0, lo: 5 }));
  try {
    const entries = Accounts.scan(root);
    assert.deepEqual(
      entries.map((entry) => entry.index),
      [1, 2, 3, null],
    );
    const [first, second, broken, extra] = entries;
    assert.equal(first.file, 'bot-1.json');
    assert.equal(first.tag, TagCodec.logicLongToTag(0, 101));
    assert.equal(first.hasToken, true);
    assert.equal(first.bindToken, false);
    assert.ok(first.size > 0);
    assert.match(first.updatedAt, /^\d{4}-\d\d-\d\dT/);
    assert.equal(second.club, '#TEAM2');
    assert.ok(broken.error);
    assert.equal(broken.hasToken, false);
    assert.equal(extra.index, null);
    assert.equal(extra.tag, TagCodec.logicLongToTag(0, 5));
  } finally {
    clean(root);
  }
});
test('find находит аккаунт по индексу, тегу, нику и имени файла', () => {
  const root = tempRoot();
  writeAccount(root, 1, { name: 'First' });
  writeAccount(root, 2, { name: 'Second' });
  writeAccount(root, 7, { name: 'Seventh' });
  try {
    const tag = TagCodec.logicLongToTag(0, 107);
    assert.equal(Accounts.find(root, 2).file, 'bot-2.json');
    assert.equal(Accounts.find(root, '7').file, 'bot-7.json');
    assert.equal(Accounts.find(root, 'bot-2').file, 'bot-2.json');
    assert.equal(Accounts.find(root, tag).file, 'bot-7.json');
    assert.equal(Accounts.find(root, tag.slice(1).toLowerCase()).file, 'bot-7.json');
    assert.equal(Accounts.find(root, 'Seventh').file, 'bot-7.json');
    assert.equal(Accounts.find(root, 'bot-1.json').index, 1);
    assert.equal(Accounts.find(root, 'missing'), null);
    assert.equal(Accounts.find(root, 99), null);
  } finally {
    clean(root);
  }
});
test('refresh пишет index.json с версией и правами 0600', () => {
  const root = tempRoot();
  writeAccount(root, 1);
  writeAccount(root, 2);
  try {
    const value = Accounts.refresh(root);
    assert.equal(value.version, 1);
    const file = Accounts.registryPath(root);
    assert.ok(fs.existsSync(file));
    const stored = registry(root);
    assert.equal(stored.version, 1);
    assert.equal(stored.accounts.length, 2);
    assert.match(stored.updatedAt, /^\d{4}-\d\d-\d\dT/);
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally {
    clean(root);
  }
});
test('read пересобирает устаревший индекс и индекс с неверным числом файлов', () => {
  const root = tempRoot();
  writeAccount(root, 1);
  writeAccount(root, 2);
  try {
    Accounts.refresh(root);
    fs.writeFileSync(
      Accounts.registryPath(root),
      JSON.stringify({ version: 1, updatedAt: new Date(0).toISOString(), accounts: [] }),
    );
    assert.equal(Accounts.read(root).accounts.length, 2, 'старый updatedAt пересобирает индекс');
    writeAccount(root, 3);
    assert.equal(Accounts.read(root).accounts.length, 3, 'расхождение числа файлов пересобирает индекс');
    assert.equal(registry(root).accounts.length, 3);
  } finally {
    clean(root);
  }
});
test('upsert точечно обновляет запись и не теряет остальные', () => {
  const root = tempRoot();
  writeAccount(root, 1);
  writeAccount(root, 2);
  try {
    Accounts.refresh(root);
    Accounts.upsert(root, { passToken: 'new', hi: 0, lo: 302, name: 'Renamed', club: '#NEW' }, 'accounts/bot-2.json');
    const stored = registry(root);
    assert.equal(stored.accounts.length, 2);
    const updated = stored.accounts.find((entry) => entry.index === 2);
    assert.equal(updated.name, 'Renamed');
    assert.equal(updated.tag, TagCodec.logicLongToTag(0, 302));
    assert.equal(updated.club, '#NEW');
    assert.equal(updated.hasToken, true);
    assert.equal(stored.accounts.find((entry) => entry.index === 1).name, null);
    if (process.platform !== 'win32') assert.equal(fs.statSync(Accounts.registryPath(root)).mode & 0o777, 0o600);
  } finally {
    clean(root);
  }
});
test('100 upsert не делают полный скан accounts/*.json', () => {
  const root = tempRoot();
  const originalReaddir = fs.readdirSync;
  let scans = 0;
  try {
    for (let index = 1; index <= 100; index++) writeAccount(root, index, { name: `Bot${index}` });
    Accounts.refresh(root);
    const accountsDir = path.resolve(Accounts.accountsDir(root));
    fs.readdirSync = function (target, ...rest) {
      if (path.resolve(String(target)) === accountsDir) scans++;
      return originalReaddir.call(fs, target, ...rest);
    };
    for (let index = 1; index <= 100; index++)
      Accounts.upsert(
        root,
        { passToken: 'test-token', hi: 0, lo: 100 + index, name: `Renamed${index}` },
        `accounts/bot-${index}.json`,
      );
    Accounts.flush(root);
    assert.equal(scans, 0, 'upsert/flush не должны сканировать каталог аккаунтов');
    const stored = registry(root);
    assert.equal(stored.accounts.length, 100);
    assert.equal(stored.accounts.find((entry) => entry.index === 100).name, 'Renamed100');
    assert.equal(stored.accounts.find((entry) => entry.index === 1).name, 'Renamed1');
  } finally {
    fs.readdirSync = originalReaddir;
    clean(root);
  }
});

test('read после upsert видит точечные изменения, refresh пересобирает индекс заново', () => {
  const root = tempRoot();
  writeAccount(root, 1, { name: 'First' });
  writeAccount(root, 2, { name: 'Second' });
  try {
    Accounts.refresh(root);
    Accounts.upsert(root, { passToken: 'test-token', hi: 0, lo: 101, name: 'Updated' }, 'accounts/bot-1.json');
    Accounts.flush(root);
    assert.equal(Accounts.read(root).accounts.find((entry) => entry.index === 1).name, 'Updated');
    // refresh — источник истины — возвращает данные из файлов, а не из памяти.
    const rescanned = Accounts.refresh(root);
    assert.equal(rescanned.accounts.find((entry) => entry.index === 1).name, 'First');
    assert.equal(registry(root).accounts.length, 2);
  } finally {
    clean(root);
  }
});

test('prune --dry-run ничего не удаляет, prune убирает пустые и осиротевшие файлы', () => {
  const root = tempRoot();
  writeAccount(root, 1, { name: 'First' });
  writeAccount(root, 2, { passToken: undefined, name: 'NoToken' });
  fs.writeFileSync(path.join(root, 'accounts', 'bot-4.json'), '{}');
  fs.writeFileSync(path.join(root, 'accounts', 'bot-5.json'), JSON.stringify({ bindToken: 'bind-only' }));
  fs.writeFileSync(path.join(root, 'accounts', 'bot-4.json.lock'), '{}');
  fs.writeFileSync(path.join(root, 'accounts', 'bot-1.json.lock'), '{}');
  try {
    const dry = Accounts.prune(root, { dryRun: true });
    assert.equal(dry.dryRun, true);
    assert.ok(dry.removed.some((item) => item.file === 'bot-4.json' && item.reason === 'empty'));
    assert.ok(fs.existsSync(path.join(root, 'accounts', 'bot-4.json')), 'dryRun не удаляет');
    assert.ok(fs.existsSync(path.join(root, 'accounts', 'bot-4.json.lock')), 'dryRun не удаляет lock');
    const report = Accounts.prune(root);
    assert.equal(fs.existsSync(path.join(root, 'accounts', 'bot-4.json')), false);
    assert.equal(fs.existsSync(path.join(root, 'accounts', 'bot-4.json.lock')), false);
    assert.ok(fs.existsSync(path.join(root, 'accounts', 'bot-1.json')), 'файл с токеном не удаляется');
    assert.ok(fs.existsSync(path.join(root, 'accounts', 'bot-1.json.lock')), 'lock живого аккаунта не удаляется');
    assert.ok(fs.existsSync(path.join(root, 'accounts', 'bot-2.json')), 'файл с hi/lo не удаляется');
    assert.ok(fs.existsSync(path.join(root, 'accounts', 'bot-5.json')), 'файл с bindToken не удаляется');
    assert.ok(report.removed.every((item) => item.file !== 'bot-1.json'));
  } finally {
    clean(root);
  }
});
test('stats считает всего, с токеном, с клубом и битые', () => {
  const root = tempRoot();
  writeAccount(root, 1, { name: 'First', club: '#CLUB' });
  writeAccount(root, 2, { passToken: undefined, name: 'NoToken' });
  writeAccount(root, 3);
  fs.writeFileSync(path.join(root, 'accounts', 'bot-4.json'), '{');
  try {
    assert.deepEqual(Accounts.stats(root), { total: 4, withToken: 2, withClub: 1, broken: 1 });
  } finally {
    clean(root);
  }
});
test('cleanup удаляет старые results, зависшие .processing и просроченные .tmp-*/.lock', () => {
  const root = tempRoot();
  const results = path.join(root, '.runtime', 'results'),
    commands = path.join(root, '.runtime', 'commands');
  fs.mkdirSync(results, { recursive: true });
  fs.mkdirSync(commands, { recursive: true });
  const old = path.join(results, 'aaaaaaaa-bbbb-cccc-dddd-eeeeffff0000.json'),
    fresh = path.join(results, '11111111-2222-3333-4444-555566667777.json'),
    stuck = path.join(commands, '99999999-2222-3333-4444-555566667777.json.processing'),
    temp = path.join(commands, 'bot-1.json.tmp-123'),
    lock = path.join(root, '.runtime', 'old.lock');
  for (const file of [old, fresh, stuck, temp, lock]) fs.writeFileSync(file, '{}');
  const oldDate = new Date(Date.now() - 2 * 3600000),
    stuckDate = new Date(Date.now() - 20 * 60000),
    staleDate = new Date(Date.now() - 2 * 86400000);
  fs.utimesSync(old, oldDate, oldDate);
  fs.utimesSync(stuck, stuckDate, stuckDate);
  fs.utimesSync(temp, staleDate, staleDate);
  fs.utimesSync(lock, staleDate, staleDate);
  try {
    const report = Accounts.cleanup(root);
    assert.deepEqual(report.results, [path.basename(old)]);
    assert.deepEqual(report.processing, [path.basename(stuck)]);
    assert.ok(report.stale.includes(path.basename(temp)));
    assert.ok(report.stale.includes(path.basename(lock)));
    assert.equal(report.removed, 4);
    assert.equal(fs.existsSync(old), false);
    assert.equal(fs.existsSync(fresh), true, 'свежий результат не удаляется');
    assert.equal(fs.existsSync(stuck), false);
  } finally {
    clean(root);
  }
});
