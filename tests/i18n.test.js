'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const i18n = require('../lib/i18n');
const { check } = require('../tools/i18n-check');

const root = path.resolve(__dirname, '..');

test('resolve принимает теги локалей и не бросает на неизвестных', () => {
  assert.equal(i18n.resolve('ru'), 'ru');
  assert.equal(i18n.resolve('ru-RU'), 'ru');
  assert.equal(i18n.resolve('en_US'), 'en');
  assert.equal(i18n.resolve('tr-TR'), 'tr');
  assert.equal(i18n.resolve('zh-CN'), 'zh');
  assert.equal(i18n.resolve('ru_RU.UTF-8'), 'ru');
  assert.equal(i18n.resolve('xx'), null);
  assert.equal(i18n.resolve(''), null);
  assert.equal(i18n.resolve(undefined), null);
  assert.equal(i18n.resolve(42), null);
  assert.deepEqual(i18n.languages(), ['ru', 'en', 'tr', 'zh']);
  assert.equal(i18n.DEFAULT, 'ru');
});

test('t подставляет плейсхолдеры, сохраняет неизвестные и возвращает ключ при промахе', () => {
  i18n.setLanguage('ru');
  assert.equal(i18n.t('cli.help.commands', { commands: 'login, friends' }), 'Команды: login, friends');
  assert.equal(i18n.t('tui.lang.saved', { language: 'Турецкий' }), 'язык интерфейса сохранён: Турецкий');
  assert.equal(i18n.t('cli.help.title', { version: '9.9.9' }), 'Nulls Headless Client 9.9.9');
  assert.equal(i18n.t('нет.такого.ключа'), 'нет.такого.ключа');
  assert.equal(i18n.t(''), '');
  assert.equal(i18n.has('cli.help.title'), true);
  assert.equal(i18n.has('нет.такого.ключа'), false);
  assert.equal(i18n.t('cli.help.lang', {}), 'Язык интерфейса: --lang ru|en|tr|zh; текущий — {language}');
});

test('t падает на en, если в текущем каталоге ключа нет', () => {
  const realRead = fs.readFileSync;
  const empty = { 'cli.help.title': 'Nulls Headless Client {version}' };
  fs.readFileSync = function patched(file, ...rest) {
    if (String(file).endsWith(`${path.sep}tr.json`) && String(file).includes('locales')) {
      return JSON.stringify(empty);
    }
    return realRead.call(fs, file, ...rest);
  };
  try {
    i18n.clearCache();
    i18n.setLanguage('tr');
    assert.equal(i18n.t('tui.action.ready'), 'press ready');
    assert.equal(i18n.t('cli.help.title', { version: '1.0' }), 'Nulls Headless Client 1.0');
  } finally {
    fs.readFileSync = realRead;
    i18n.clearCache();
    i18n.setLanguage('ru');
  }
});

test('все каталоги проходят валидатор', () => {
  const result = check();
  assert.ok(result.ok, result.errors.join('\n'));
  assert.ok(result.keys > 200, `слишком мало ключей: ${result.keys}`);
});

test('приоритет языка: аргумент -> config.uiLanguage -> env -> ru', () => {
  assert.equal(i18n.detect({ lang: 'tr-TR', config: { uiLanguage: 'en' }, env: { NULLS_LANG: 'zh' } }), 'tr');
  assert.equal(i18n.detect({ lang: 'xx', config: { uiLanguage: 'en' }, env: { NULLS_LANG: 'zh' } }), 'en');
  assert.equal(i18n.detect({ config: {}, env: { NULLS_LANG: 'zh' } }), 'zh');
  assert.equal(i18n.detect({ config: {}, env: { LANG: 'ru_RU.UTF-8' } }), 'ru');
  assert.equal(i18n.detect({ config: {}, env: { LANG: 'C' } }), 'ru');
  assert.equal(i18n.fromEnv({ LC_ALL: 'tr_TR.UTF-8' }), 'tr');
  assert.equal(i18n.fromEnv({}), null);
});

test('auto: env -> системная локаль -> ru, явный код важнее auto', () => {
  assert.equal(i18n.resolveMode('auto'), 'auto');
  assert.equal(i18n.resolveMode('AUTO'), 'auto');
  assert.equal(i18n.resolveMode('tr-TR'), 'tr');
  assert.equal(i18n.resolveMode('xx'), null);
  assert.deepEqual(i18n.detectInfo({ config: { uiLanguage: 'auto' }, env: { LANG: 'tr_TR.UTF-8' } }), {
    language: 'tr',
    mode: 'auto',
    source: 'env',
  });
  assert.deepEqual(i18n.detectInfo({ config: { uiLanguage: 'auto' }, env: {}, systemLocale: 'zh-CN' }), {
    language: 'zh',
    mode: 'auto',
    source: 'system',
  });
  assert.deepEqual(i18n.detectInfo({ config: { uiLanguage: 'auto' }, env: {}, systemLocale: 'xx-YY' }), {
    language: 'ru',
    mode: 'auto',
    source: 'default',
  });
  // LANG=C — локаль задана, но языка в ней нет: запасной ru.
  assert.equal(i18n.detectInfo({ config: { uiLanguage: 'auto' }, env: { LANG: 'C' } }).language, 'ru');
  // Отсутствие uiLanguage в конфиге тоже означает auto.
  assert.deepEqual(i18n.detectInfo({ config: {}, env: { LANG: 'tr_TR.UTF-8' } }), {
    language: 'tr',
    mode: 'auto',
    source: 'env',
  });
  assert.deepEqual(i18n.detectInfo({ lang: 'en', config: { uiLanguage: 'auto' }, env: { LANG: 'tr_TR.UTF-8' } }), {
    language: 'en',
    mode: 'fixed',
    source: 'lang',
  });
  assert.deepEqual(i18n.detectInfo({ config: { uiLanguage: 'en' }, env: { LANG: 'tr_TR.UTF-8' } }), {
    language: 'en',
    mode: 'fixed',
    source: 'config',
  });
  const system = i18n.systemLocale();
  assert.ok(system === null || typeof system === 'string');
});

test('CLI: auto берёт язык из env, --lang важнее auto, lang auto сохраняет режим', () => {
  const auto = fixture({ uiLanguage: 'auto' });
  try {
    const byEnv = JSON.parse(run(auto, ['lang'], { LANG: 'tr_TR.UTF-8' }).stdout);
    assert.equal(byEnv.language, 'tr');
    assert.equal(byEnv.mode, 'auto');
    assert.equal(byEnv.source, 'env');
    assert.equal(byEnv.configured, 'auto');

    const emptyEnv = run(auto, ['lang'], { NULLS_LANG: '', LC_ALL: '', LC_MESSAGES: '', LANG: '' });
    assert.equal(emptyEnv.status, 0, emptyEnv.stderr);
    const bySystem = JSON.parse(emptyEnv.stdout);
    assert.ok(['ru', 'en', 'tr', 'zh'].includes(bySystem.language));
    assert.equal(bySystem.mode, 'auto');
    assert.ok(['system', 'default'].includes(bySystem.source), bySystem.source);

    const byFlag = JSON.parse(run(auto, ['lang', '--lang', 'en'], { LANG: 'tr_TR.UTF-8' }).stdout);
    assert.equal(byFlag.language, 'en');
    assert.equal(byFlag.mode, 'fixed');
    assert.equal(byFlag.source, 'lang');
  } finally {
    fs.rmSync(auto, { recursive: true, force: true });
  }
  const fixed = fixture({ uiLanguage: 'ru' });
  try {
    const enabled = JSON.parse(run(fixed, ['lang', 'auto']).stdout);
    assert.equal(enabled.saved, true);
    assert.equal(enabled.mode, 'auto');
    assert.equal(enabled.language, 'ru');
    assert.equal(JSON.parse(fs.readFileSync(path.join(fixed, 'config.json'), 'utf8')).uiLanguage, 'auto');
  } finally {
    fs.rmSync(fixed, { recursive: true, force: true });
  }
});

function fixture(config = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nulls-i18n-'));
  fs.copyFileSync(path.join(root, 'Program.js'), path.join(dir, 'Program.js'));
  // lib/utils копируем: ROOT вычисляется от __dirname, симлинк увёл бы запись config.json в рабочий репозиторий.
  for (const name of ['lib', 'utils']) {
    fs.cpSync(path.join(root, name), path.join(dir, name), { recursive: true });
  }
  for (const name of ['docs', 'data', 'Crypto', 'Messaging', 'TcpSocket', 'DataStream', 'node_modules']) {
    const source = path.join(root, name);
    if (fs.existsSync(source)) fs.symlinkSync(source, path.join(dir, name), 'dir');
  }
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'nulls-fixture', version: '0.2.7' }, null, 2) + '\n',
  );
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify(
      {
        host: 'example.invalid',
        port: 9339,
        appBinaryVersion: '0.0.0',
        major: 0,
        minor: 0,
        build: 0,
        cryptoMode: 'none',
        loginLayout: 'legacy',
        locale: 'ru-RU',
        preferredLanguage: 'ru',
        uiLanguage: 'ru',
        ...config,
      },
      null,
      2,
    ) + '\n',
  );
  return dir;
}

function run(dir, args, env = {}) {
  return spawnSync(process.execPath, [path.join(dir, 'Program.js'), ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, NULLS_LANG: '', LC_ALL: '', LANG: 'C', ...env },
  });
}

test('CLI: lang печатает текущий язык и список поддерживаемых', () => {
  const dir = fixture();
  try {
    const result = run(dir, ['lang']);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.language, 'ru');
    assert.deepEqual(
      output.supported.map((item) => item.code),
      ['ru', 'en', 'tr', 'zh'],
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: lang tr сохраняет выбор и подтверждает на выбранном языке', () => {
  const dir = fixture();
  try {
    const result = run(dir, ['lang', 'tr']);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.language, 'tr');
    assert.equal(output.saved, true);
    assert.match(output.message, /kaydedildi/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).uiLanguage, 'tr');
    const again = JSON.parse(run(dir, ['lang']).stdout);
    assert.equal(again.language, 'tr');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: неизвестный язык даёт код 2 (ошибка аргумента) и понятное сообщение', () => {
  const dir = fixture();
  try {
    const result = run(dir, ['lang', 'xx']);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /не поддерживается/);
    assert.match(result.stderr, /ru, en, tr, zh/);
    const flag = run(dir, ['help', '--lang', 'xx']);
    assert.equal(flag.status, 2);
    assert.match(flag.stderr, /не поддерживается/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: --lang и config.uiLanguage работают на любой команде', () => {
  const dir = fixture();
  try {
    assert.match(run(dir, ['help', '--lang', 'tr']).stdout, /Komutlar:/);
    assert.match(run(dir, ['help']).stdout, /Команды:/);
    fs.writeFileSync(
      path.join(dir, 'config.json'),
      JSON.stringify(
        { ...JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')), uiLanguage: 'en' },
        null,
        2,
      ) + '\n',
    );
    assert.match(run(dir, ['help']).stdout, /Commands:/);
    const info = JSON.parse(run(dir, ['info', '--lang', 'zh']).stdout);
    assert.equal(info.language, 'zh');
    assert.equal(info.version, '0.2.7');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
