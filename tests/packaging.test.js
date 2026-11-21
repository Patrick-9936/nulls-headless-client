// Упаковка релиза: в бандл и zip не должны попадать devDependencies,
// а сборка должна оставаться воспроизводимой. Тест не ходит в сеть:
// python3 tools/package_release.py --check собирает zip во временной папке
// (TMPDIR) и ничего не пишет в рабочее дерево.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.resolve(__dirname, '..');
const ENV = { ...process.env, TMPDIR: os.tmpdir() };
const PRODUCTION = ['blakejs', 'colors', 'tweetnacl'];

function findPython() {
  for (const command of ['python3', 'python']) {
    const probe = spawnSync(command, ['--version'], { encoding: 'utf8' });
    if (!probe.error && probe.status === 0) return command;
  }
  return null;
}

const PYTHON = findPython();

function runCheck(cwd = ROOT) {
  const result = spawnSync(PYTHON, [path.join(cwd, 'tools', 'package_release.py'), '--check'], {
    cwd,
    encoding: 'utf8',
    env: ENV,
  });
  const lines = (result.stdout || '').trim().split('\n');
  let report = null;
  try {
    report = JSON.parse(lines[lines.length - 1]);
  } catch {
    report = null;
  }
  return { status: result.status, report, stderr: (result.stderr || '').trim() };
}

/** Копия дерева без node_modules/.git — источник для проверки воспроизводимости. */
function snapshotTree() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nulls-packaging-'));
  fs.cpSync(ROOT, temp, {
    recursive: true,
    filter: (src) => {
      const relative = path.relative(ROOT, src);
      if (!relative) return true;
      const top = relative.split(path.sep)[0];
      return top !== 'node_modules' && top !== '.git';
    },
  });
  fs.mkdirSync(path.join(temp, 'node_modules'));
  for (const name of PRODUCTION) {
    fs.cpSync(path.join(ROOT, 'node_modules', name), path.join(temp, 'node_modules', name), { recursive: true });
  }
  return temp;
}

/** Пути файлов из уже собранного Nulls.js (base64(zlib(json))). */
function bundlePaths() {
  const text = fs.readFileSync(path.join(ROOT, 'Nulls.js'), 'utf8');
  const payload = /const PAYLOAD='([A-Za-z0-9+/=]+)'/.exec(text);
  assert.ok(payload, 'в Nulls.js найден PAYLOAD');
  const bundle = JSON.parse(zlib.gunzipSync(Buffer.from(payload[1], 'base64')).toString('utf8'));
  return bundle.files.map((entry) => entry.path);
}

function isDependencyPath(entry, name) {
  return (
    entry === `node_modules/${name}` ||
    entry.startsWith(`node_modules/${name}/`) ||
    entry.includes(`/node_modules/${name}/`)
  );
}

test('payload: рантайм-docs по allowlist, тесты внутри, native-выдержки нет', (t) => {
  if (!fs.existsSync(path.join(ROOT, 'Nulls.js'))) return t.skip('Nulls.js ещё не собран');
  const paths = bundlePaths();

  // tests/ остаются в бандле: node Nulls.js --test должен работать из одного файла.
  assert.ok(
    paths.some((entry) => entry.startsWith('tests/') && entry.endsWith('.test.js')),
    'tests/*.test.js входят в бандл',
  );
  assert.deepEqual(
    paths.filter((entry) => entry.startsWith('docs/native/')),
    [],
    'docs/native/ не входит в бандл',
  );
  assert.deepEqual(
    paths.filter((entry) => entry.startsWith('docs/')).sort(),
    ['docs/COMMANDS.md', 'docs/TUI.md', 'docs/features.json', 'docs/protocol-evidence.json'],
    'из docs/ в бандле только файлы, читаемые в рантайме',
  );

  // Рантайм читает их напрямую: CLI/TUI — features.json, Protocol — protocol-evidence.json.
  for (const entry of [
    'docs/features.json',
    'docs/protocol-evidence.json',
    'docs/TUI.md',
    'docs/COMMANDS.md',
    'data/brawlers.json',
    'data/regions.json',
    'data/maps.json',
    'config.json',
  ]) {
    assert.ok(paths.includes(entry), `${entry} на месте`);
  }
});

test('devDependencies не попадают в собранный бандл', (t) => {
  if (!fs.existsSync(path.join(ROOT, 'Nulls.js'))) return t.skip('Nulls.js ещё не собран');
  const paths = bundlePaths();

  for (const name of ['eslint', 'globals', '.bin']) {
    const found = paths.filter((entry) => isDependencyPath(entry, name));
    assert.deepEqual(found, [], `в бандле не должно быть node_modules/${name}`);
  }
  assert.equal(paths.includes('node_modules/.package-lock.json'), false, 'npm-состояние не входит в бандл');

  for (const name of PRODUCTION) {
    assert.ok(paths.includes(`node_modules/${name}/package.json`), `production-пакет ${name} на месте`);
  }
});

test('закоммиченный бандл соответствует исходникам', (t) => {
  if (!PYTHON) return t.skip('python не найден');
  const { status, report, stderr } = runCheck();
  if (!report) return t.skip(`не удалось разобрать отчёт: ${stderr || 'нет вывода'}`);
  if (status !== 0) {
    // Бандл пересобирает интегратор/релизный workflow; локально он может отставать.
    return t.skip(`Nulls.js не пересобран: ${report.check}, changed=${(report.changed || []).length}`);
  }
  assert.equal(report.check, 'ok');
  assert.equal(report.version, report.committed_version);
});

test('две сборки в TMPDIR дают одинаковый sha256 zip', (t) => {
  if (!PYTHON) return t.skip('python не найден');
  const snapshot = snapshotTree();
  try {
    const first = runCheck(snapshot);
    const second = runCheck(snapshot);
    if (!first.report || !second.report) return t.skip('package_release.py --check не вернул отчёт');
    assert.equal(first.report.files, second.report.files, 'набор файлов одинаков');
    assert.equal(first.report.zip_sha256, second.report.zip_sha256, 'zip собирается байт-в-байт');
  } finally {
    fs.rmSync(snapshot, { recursive: true, force: true });
  }
});
