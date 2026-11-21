const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const Platform = require('../utils/Platform');
test('платформенные предикаты возвращают булевы значения', () => {
  for (const name of ['isAndroid', 'isWindows', 'isMac', 'isLinux']) {
    assert.equal(typeof Platform[name](), 'boolean');
  }
  assert.equal(Platform.isWindows() && Platform.isMac(), false);
  assert.equal(Platform.isWindows() || Platform.isMac() || Platform.isLinux(), true);
});
test('pythonCommand кэширует результат и не бросает исключение', () => {
  let first;
  assert.doesNotThrow(() => {
    first = Platform.pythonCommand();
  });
  assert.ok(first === null || typeof first === 'string');
  assert.equal(Platform.pythonCommand(), first);
});
test('wakeLock вне Android — no-op без запуска процессов', () => {
  if (Platform.isAndroid()) return;
  assert.equal(Platform.wakeLock(true), false);
  assert.equal(Platform.wakeLock(false), false);
});
test('supportsApkUpdate разрешает явный APK на любой платформе', () => {
  assert.equal(Platform.supportsApkUpdate({ apk: 'base.apk' }), true);
  assert.equal(Platform.supportsApkUpdate({ splitAPK: 'split.apk' }), true);
  assert.equal(typeof Platform.supportsApkUpdate(), 'boolean');
});
test('fileModeSecure ставит 0600 на POSIX и не падает на Windows', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nulls-platform-')),
    file = path.join(root, 'secret');
  try {
    fs.writeFileSync(file, 'x', { mode: 0o644 });
    let result;
    assert.doesNotThrow(() => {
      result = Platform.fileModeSecure(file);
    });
    if (Platform.isWindows()) {
      assert.equal(result, false);
      assert.equal(fs.existsSync(file), true);
    } else {
      assert.equal(result, true);
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
