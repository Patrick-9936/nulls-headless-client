const test = require('node:test'),
  assert = require('node:assert/strict');
const { main, splitGlobals, makeLogger } = require('../lib/CLI');

// Вызов CLI в том же процессе: без сети и без запуска флота, быстро.
async function run(args, env = {}) {
  const stdout = [],
    stderr = [];
  const write = process.stdout.write;
  const writeErr = process.stderr.write;
  const savedExit = process.exitCode;
  const savedEnv = {};
  for (const [key, value] of Object.entries(env)) {
    savedEnv[key] = process.env[key];
    process.env[key] = value;
  }
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
    await main(args);
  } finally {
    process.stdout.write = write;
    process.stderr.write = writeErr;
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  const status = process.exitCode || 0;
  process.exitCode = savedExit;
  return { stdout: stdout.join(''), stderr: stderr.join(''), status };
}

function onlyJson(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim().split('\n').length, 1, `лишние строки в stdout: ${result.stdout}`);
  return JSON.parse(result.stdout);
}

test('--json: info отдаёт один объект без человеческих строк', async () => {
  const output = onlyJson(await run(['info', '--json']));
  assert.equal(output.ok, true);
  assert.equal(typeof output.result.version, 'string');
  assert.equal(typeof output.result.host, 'string');
});

test('--json: lang и features тоже машиночитаемы', async () => {
  const lang = onlyJson(await run(['lang', '--json']));
  assert.equal(lang.ok, true);
  assert.deepEqual(
    lang.result.supported.map((item) => item.code),
    ['ru', 'en', 'tr', 'zh'],
  );
  const features = onlyJson(await run(['features', '--json']));
  assert.equal(features.ok, true);
  assert.ok(Array.isArray(features.result.commands));
});

test('--json: help превращается в объект, а не в текст', async () => {
  const help = onlyJson(await run(['help', '--json']));
  assert.equal(help.ok, true);
  assert.ok(Array.isArray(help.result.commands));
  assert.match(help.result.text, /node Program\.js/);
});

test('--json: ошибка уходит в stderr как JSON и даёт код 2 (INVALID_ARGUMENT)', async () => {
  const result = await run(['nope', '--json']);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  const error = JSON.parse(result.stderr.trim());
  assert.equal(error.ok, false);
  assert.equal(typeof error.error.message, 'string');
  assert.match(error.error.message, /nope/);
});

test('--json=false возвращает прежний pretty-JSON', async () => {
  const result = await run(['info', '--json=false']);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.startsWith('{\n  "version"'), result.stdout.slice(0, 40));
  assert.equal(JSON.parse(result.stdout).version !== undefined, true);
});

test('--quiet не ломает результат и глушит предупреждения', async () => {
  const output = onlyJsonLike(await run(['info', '--quiet']));
  assert.equal(typeof output.version, 'string');

  const cli = makeLogger({ quiet: true });
  const written = [];
  const original = console.error;
  console.error = (...args) => written.push(args.join(' '));
  try {
    cli.warning(new Error('шум протокола'));
    cli.installDebugger();
    global.Debugger.info('строка отладки');
    global.Debugger.warn('ещё строка');
  } finally {
    console.error = original;
    delete global.Debugger;
  }
  assert.deepEqual(written, []);
});

test('--quiet=false всё ещё печатает предупреждения', () => {
  const cli = makeLogger({ quiet: false });
  const written = [];
  const original = console.error;
  console.error = (...args) => written.push(args.join(' '));
  try {
    cli.warning(new Error('важно'));
  } finally {
    console.error = original;
  }
  assert.deepEqual(written, ['важно']);
});

test('--quiet не съедает следующий аргумент и не мешает --json', async () => {
  const { flags, argv } = splitGlobals(['info', '--quiet', '--json', '--lang', 'ru', '--json=false']);
  assert.deepEqual(flags, { json: false, quiet: true, noColor: false });
  assert.deepEqual(argv, ['info', '--lang', 'ru']);

  const output = onlyJson(await run(['lang', '--quiet', '--json', '--lang', 'ru']));
  assert.equal(output.ok, true);
  assert.equal(output.result.language, 'ru');
});

test('--no-color вынимается до parse и не требует значения', () => {
  const { flags, argv } = splitGlobals(['watch', '--no-color', '--once']);
  assert.equal(flags.noColor, true);
  assert.deepEqual(argv, ['watch', '--once']);
});

function onlyJsonLike(result) {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
