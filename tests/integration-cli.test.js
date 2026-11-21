// Интеграция CLI (lib/CLI.js#main) целиком: отдельный процесс node с настоящим
// lib/CLI.js, но временным корнем и заглушками Client/Actions/Protocol.
// Сеть не нужна, рабочее дерево репозитория не меняется, всё живёт в os.tmpdir().
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const NODE = process.execPath;
const COPIES = [
  'lib/CLI.js',
  'lib/Args.js',
  'lib/Store.js',
  'lib/Errors.js',
  'lib/i18n.js',
  'utils/TagCodec.js',
  'lib/locales/ru.json',
  'lib/locales/en.json',
  'lib/locales/tr.json',
  'lib/locales/zh.json',
];

// Заглушки вместо сети: CLI подключает их по относительному пути.
const STUBS = {
  'lib/Protocol.js': `'use strict';
function integer(value, name, min = 0, max = 0x7fffffff) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(name + ': требуется число ' + min + '–' + max);
  return n;
}
function encode() {
  throw new Error('offline fixture: Protocol.encode не должен вызываться');
}
module.exports = { integer, encode };
`,
  'lib/Actions.js': `'use strict';
const commands = ['login', 'friends', 'create-account', 'team-info'];
async function execute(client, command) {
  if (command === 'friends') {
    client.emit('warning', new Error('предупреждение протокола'));
    return { command, friends: [] };
  }
  return { command };
}
function same() {
  return false;
}
module.exports = { commands, execute, same };
`,
  'lib/Client.js': `'use strict';
const { EventEmitter } = require('node:events');
module.exports = class Client extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.state = 'queued';
    this.attempts = 0;
  }
  async connect() {
    this.state = 'online';
    return this;
  }
  close() {
    this.state = 'closed';
  }
};
`,
};

const RUNNER = `'use strict';
const { main } = require('./lib/CLI');
const cases = __CASES__;
// Детерминированный язык по умолчанию: LANG=C -> auto выбирает ru.
const base = { ...process.env };
for (const key of ['NULLS_LANG', 'LC_ALL', 'LC_MESSAGES', 'LANGUAGE']) delete base[key];
base.LANG = 'C';

async function run(spec) {
  const stdout = [];
  const stderr = [];
  const writeOut = process.stdout.write;
  const writeErr = process.stderr.write;
  const savedExit = process.exitCode;
  const savedDebugger = global.Debugger;
  for (const key of ['NULLS_LANG', 'LC_ALL', 'LC_MESSAGES', 'LANGUAGE', 'LANG']) delete process.env[key];
  Object.assign(process.env, base, spec.env || {});
  process.stdout.write = (chunk) => {
    stdout.push(String(chunk));
    return true;
  };
  process.stderr.write = (chunk) => {
    stderr.push(String(chunk));
    return true;
  };
  process.exitCode = undefined;
  try {
    await main(spec.args);
  } catch (error) {
    stderr.push('THROW: ' + error.message);
    process.exitCode = 1;
  } finally {
    process.stdout.write = writeOut;
    process.stderr.write = writeErr;
    global.Debugger = savedDebugger;
  }
  const status = process.exitCode || 0;
  process.exitCode = savedExit;
  return { name: spec.name, stdout: stdout.join(''), stderr: stderr.join(''), status };
}

(async () => {
  const output = [];
  for (const spec of cases) output.push(await run(spec));
  process.stdout.write(JSON.stringify(output));
})().catch((error) => {
  process.stderr.write((error && error.stack) || String(error));
  process.exitCode = 1;
});
`;

function copy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nulls-int-cli-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'cli-fixture', version: '9.9.9' }));
  fs.writeFileSync(
    path.join(root, 'config.json'),
    JSON.stringify(
      {
        host: 'fixture.invalid',
        port: 9339,
        appBinaryVersion: '69.252',
        major: 69,
        minor: 252,
        build: 44,
        cryptoMode: 'fixture',
        uiLanguage: 'auto',
      },
      null,
      2,
    ),
  );
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'features.json'), JSON.stringify({ commands: ['login', 'friends'] }));
  for (const file of COPIES) copy(path.join(REPO, file), path.join(root, file));
  for (const [target, source] of Object.entries(STUBS)) {
    fs.mkdirSync(path.dirname(path.join(root, target)), { recursive: true });
    fs.writeFileSync(path.join(root, target), source);
  }
  const accountFile = path.join(root, 'accounts', 'bot-9.json');
  fs.mkdirSync(path.dirname(accountFile), { recursive: true });
  fs.writeFileSync(
    accountFile,
    JSON.stringify({ hi: 0, lo: 900, name: 'Nine', club: '#ABC', passToken: 'token-9' }, null, 2),
  );
  const cases = [
    { name: 'info', args: ['info', '--json'] },
    { name: 'lang', args: ['lang', '--json'] },
    { name: 'features', args: ['features', '--json'] },
    { name: 'account', args: ['account-info', '--json', '--account', accountFile] },
    { name: 'unknown', args: ['nope', '--json'] },
    { name: 'pretty', args: ['info', '--json=false'] },
    { name: 'friends-noisy', args: ['friends', '--json', '--account', accountFile] },
    { name: 'friends-quiet', args: ['friends', '--quiet', '--json', '--account', accountFile] },
    { name: 'help-tr', args: ['help', '--lang', 'tr', '--json'] },
    { name: 'help-auto-tr', args: ['help', '--lang', 'auto', '--json'], env: { LANG: 'tr_TR.UTF-8' } },
    { name: 'help-auto-ru', args: ['help', '--lang', 'auto', '--json'] },
  ];
  fs.writeFileSync(path.join(root, 'run-cli.js'), RUNNER.replace('__CASES__', JSON.stringify(cases)));
  return root;
}

function runSuite(root) {
  return new Promise((resolve, reject) => {
    const child = spawn(NODE, [path.join(root, 'run-cli.js')], { cwd: root });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

let root;
let results;
before(async () => {
  root = makeRoot();
  const run = await runSuite(root);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr, '');
  results = new Map(JSON.parse(run.stdout).map((item) => [item.name, item]));
});
after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function singleJson(name) {
  const result = results.get(name);
  assert.ok(result, `нет кейса ${name}`);
  assert.equal(result.status, 0, `${name}: ${result.stderr}`);
  assert.equal(result.stdout.trim().split('\n').length, 1, `${name}: ожидалась одна строка JSON`);
  return JSON.parse(result.stdout);
}

test('--json: info/lang/features/account-info отдают по одному объекту', () => {
  const info = singleJson('info');
  assert.equal(info.ok, true);
  assert.equal(info.result.version, '9.9.9');
  assert.equal(info.result.host, 'fixture.invalid');
  assert.equal(info.result.language, 'ru');

  const lang = singleJson('lang');
  assert.deepEqual(
    lang.result.supported.map((item) => item.code),
    ['ru', 'en', 'tr', 'zh'],
  );

  const features = singleJson('features');
  assert.deepEqual(features.result.commands, ['login', 'friends']);

  const account = singleJson('account');
  assert.equal(account.result.name, 'Nine');
  assert.equal(account.result.club, '#ABC');
  assert.equal(account.result.saved, true);
  assert.match(account.result.tag, /^#/);
});

test('--json при ошибке: stdout пуст, stderr — JSON, код 2 (INVALID_ARGUMENT)', () => {
  const result = results.get('unknown');
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  const error = JSON.parse(result.stderr.trim());
  assert.equal(error.ok, false);
  assert.match(error.error.message, /nope/);
});

test('--json=false сохраняет прежний pretty-JSON', () => {
  const result = results.get('pretty');
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.startsWith('{\n  "version"'), result.stdout.slice(0, 40));
  assert.equal(JSON.parse(result.stdout).version, '9.9.9');
});

test('--quiet глушит warning, а без него warning идёт в stderr', () => {
  const quiet = results.get('friends-quiet');
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.deepEqual(JSON.parse(quiet.stdout).result, { command: 'friends', friends: [] });
  assert.equal(quiet.stderr.includes('предупреждение протокола'), false, quiet.stderr);

  const noisy = results.get('friends-noisy');
  assert.equal(noisy.stderr.includes('предупреждение протокола'), true, noisy.stderr);
  assert.equal(JSON.parse(noisy.stdout).ok, true);
});

test('--lang tr и --lang auto на help меняют язык вывода', () => {
  const tr = singleJson('help-tr');
  assert.equal(tr.result.language.code, 'tr');
  assert.match(tr.result.text, /Yardımcılar/);
  assert.match(tr.result.text, /Arayüz dili/);

  const autoTr = singleJson('help-auto-tr');
  assert.equal(autoTr.result.language.code, 'tr');
  assert.match(autoTr.result.text, /Yardımcılar/);

  const autoRu = singleJson('help-auto-ru');
  assert.equal(autoRu.result.language.code, 'ru');
  assert.match(autoRu.result.text, /Утилиты:/);
});

test('--json не съедает следующий аргумент', () => {
  const account = singleJson('account');
  assert.equal(account.result.name, 'Nine');
  assert.equal(account.result.saved, true);
});
