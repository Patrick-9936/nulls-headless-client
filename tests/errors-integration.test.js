// Интеграция контракта ошибок (lib/Errors.js) в Actions/Client/CLI/Fleet/AccountLock/AutoUpdate.
// Всё локально: сеть не нужна, временные каталоги в os.tmpdir(), рабочее дерево не меняется.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { AppError, codes, toJSON } = require('../lib/Errors');
const Actions = require('../lib/Actions');
const Client = require('../lib/Client');
const Fleet = require('../lib/Fleet');
const Store = require('../lib/Store');
const AccountLock = require('../lib/AccountLock');
const { main: cliMain } = require('../lib/CLI');

const REPO = path.resolve(__dirname, '..');
const tempDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const clean = (dir) => fs.rmSync(dir, { recursive: true, force: true });

// Запуск CLI в том же процессе с перехватом stdout/stderr и кода возврата.
async function runCli(args) {
  const stdout = [];
  const stderr = [];
  const writeOut = process.stdout.write;
  const writeErr = process.stderr.write;
  const savedExit = process.exitCode;
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
    await cliMain(args);
  } finally {
    process.stdout.write = writeOut;
    process.stderr.write = writeErr;
  }
  const status = process.exitCode || 0;
  process.exitCode = savedExit;
  return { status, stdout: stdout.join(''), stderr: stderr.join('') };
}

// Валидный локальный корень клиента: native19-конфиг, лицензия нужной длины, apkSize.
function clientRoot(prefix) {
  const root = tempDir(prefix);
  fs.writeFileSync(
    path.join(root, 'config.json'),
    JSON.stringify({ cryptoMode: 'nulls-native19', apkSize: 1024, host: 'fixture.invalid', port: 9339 }),
  );
  const license = Buffer.alloc(58);
  license.writeUInt16LE(0, 56);
  fs.writeFileSync(path.join(root, 'client-license.bin'), license);
  return root;
}

test('Actions: неизвестная команда — INVALID_ARGUMENT с прежним текстом', async () => {
  await assert.rejects(
    () => Actions.execute({}, 'no-such-command'),
    (error) => {
      assert.equal(error.code, 'INVALID_ARGUMENT');
      assert.equal(error.kind, 'input');
      assert.equal(error.retryable, false);
      assert.equal(error.message, 'Неизвестная команда no-such-command');
      assert.equal(error.details.command, 'no-such-command');
      return true;
    },
  );
});

test('Actions: экспериментальная команда без --experimental — INVALID_ARGUMENT', async () => {
  await assert.rejects(
    () => Actions.execute({}, 'club-invite', {}),
    (error) => {
      assert.equal(error.code, 'INVALID_ARGUMENT');
      assert.equal(error.details.command, 'club-invite');
      assert.equal(error.details.argument, 'experimental');
      assert.match(error.message, /--experimental/);
      return true;
    },
  );
});

test('Actions: пустой и неизвестный регион — INVALID_ARGUMENT', async () => {
  await assert.rejects(
    () => Actions.execute({}, 'account-region', {}),
    (error) => {
      assert.equal(error.code, 'INVALID_ARGUMENT');
      assert.equal(error.details.argument, 'region');
      assert.match(error.message, /Укажите регион/);
      return true;
    },
  );
  await assert.rejects(
    () => Actions.execute({}, 'account-region', { region: 'ZZZ' }),
    (error) => {
      assert.equal(error.code, 'INVALID_ARGUMENT');
      assert.equal(error.details.region, 'ZZZ');
      assert.match(error.message, /Неизвестный регион/);
      return true;
    },
  );
});

test('Actions: отказ сервера — STATE_ERROR с kind=server и details.serverCode', async () => {
  const client = {
    peers: new Map(),
    account: { hi: 0, lo: 3 },
    clubResponse: { code: 42 },
    async request() {
      return { command: 'club-request', confirmed: true, response: 24333 };
    },
  };
  await assert.rejects(
    () => Actions.execute(client, 'club-request', { text: 'привет', clubTag: '#2PP0' }),
    (error) => {
      assert.equal(error.code, 'STATE_ERROR');
      assert.equal(error.kind, 'server');
      assert.equal(error.retryable, false);
      assert.equal(error.details.serverCode, 42);
      assert.equal(error.details.command, 'club-request');
      assert.match(error.message, /Сервер не подтвердил отправку заявки: 42/);
      return true;
    },
  );
});

test('CLI: create-account на существующем аккаунте — STATE_ERROR и код 1', async () => {
  const root = tempDir('nulls-err-cli-account-');
  const account = path.join(root, 'account.json');
  fs.writeFileSync(account, JSON.stringify({ hi: 0, lo: 7, name: 'Seven' }));
  try {
    const result = await runCli(['create-account', '--json', '--account', account]);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '');
    const body = JSON.parse(result.stderr.trim());
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'STATE_ERROR');
    assert.equal(body.error.kind, 'state');
    assert.equal(body.error.retryable, false);
    assert.match(body.error.message, /already exists|аккаунт/i);
  } finally {
    clean(root);
  }
});

test('CLI: неизвестная команда в дочернем процессе — код 2 и INVALID_ARGUMENT', () => {
  const result = spawnSync(process.execPath, [path.join(REPO, 'Program.js'), 'nope', '--json'], {
    cwd: REPO,
    encoding: 'utf8',
  });
  assert.equal(result.status, 2, result.stderr);
  const body = JSON.parse(result.stderr.trim());
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'INVALID_ARGUMENT');
  assert.equal(body.error.kind, 'input');
  assert.equal(body.error.retryable, false);
  assert.match(body.error.message, /nope/);
});

test('Client: неподдерживаемый cryptoMode — INVALID_CONFIG без смены message', () => {
  const root = tempDir('nulls-err-client-config-');
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ cryptoMode: 'x' }));
  try {
    assert.throws(
      () => new Client({ root }),
      (error) => {
        assert.equal(error.code, 'INVALID_CONFIG');
        assert.equal(error.kind, 'config');
        assert.equal(error.message, 'Этот клиент поддерживает Nulls Native19');
        assert.equal(error.details.field, 'cryptoMode');
        assert.equal(error.details.cryptoMode, 'x');
        return true;
      },
    );
  } finally {
    clean(root);
  }
});

test('Client: неверный battleTransport — INVALID_ARGUMENT, ENOENT аккаунта не ошибка', () => {
  const root = clientRoot('nulls-err-client-args-');
  try {
    assert.throws(
      () => new Client({ root, battleTransport: 'tcp' }),
      (error) => {
        assert.equal(error.code, 'INVALID_ARGUMENT');
        assert.equal(error.details.argument, 'battleTransport');
        assert.equal(error.message, 'battle-transport: none|udp');
        return true;
      },
    );
    // Файла accounts нет — Store.read отдаёт fallback, конструктор не падает.
    const client = new Client({ root });
    assert.deepEqual(client.account, { hi: 0, lo: 0 });
    assert.equal(client.state, 'stopped');
  } finally {
    clean(root);
  }
});

test('AccountLock: занятый файл — ACCOUNT_LOCKED, retryable, details.file/pid', () => {
  const root = tempDir('nulls-err-lock-');
  const file = path.join(root, 'account.json');
  const first = new AccountLock(file);
  const second = new AccountLock(file);
  try {
    first.acquire();
    assert.throws(
      () => second.acquire(),
      (error) => {
        assert.equal(error.code, 'ACCOUNT_LOCKED');
        assert.equal(error.kind, 'state');
        assert.equal(error.retryable, true);
        assert.equal(error.details.file, file + '.lock');
        assert.equal(error.details.pid, process.pid);
        assert.match(error.message, /уже используется/);
        return true;
      },
    );
  } finally {
    first.release();
    clean(root);
  }
});

test('Fleet: отказ всей команды — ok:false + error (текст) + code/kind/retryable', async () => {
  const root = tempDir('nulls-err-fleet-result-');
  fs.mkdirSync(path.join(root, 'accounts'), { recursive: true });
  const fleet = new Fleet(root, { count: 1, commandScanInterval: 0 });
  const id = 'aaaaaaaa-1111-2222-3333-444444444444';
  try {
    // Битый файл команды: ошибка возникает вне слота и попадает в корень результата.
    fs.writeFileSync(path.join(fleet.commandDir, `${id}.json`), '{');
    await fleet.processCommands();
    const result = Store.read(path.join(root, '.runtime', 'results', `${id}.json`));
    assert.equal(result.ok, false);
    assert.match(result.error, /JSON/);
    assert.equal(result.code, 'STORE_CORRUPT');
    assert.equal(result.kind, 'state');
    assert.equal(result.retryable, false);
  } finally {
    fleet.stop();
    clean(root);
  }
});

test('Fleet: результат по боту несёт code/kind, сеть отличима от отказа сервера', async () => {
  const root = tempDir('nulls-err-fleet-item-');
  fs.mkdirSync(path.join(root, 'accounts'), { recursive: true });
  const fleet = new Fleet(root, { count: 1, commandScanInterval: 0 });
  const original = Actions.execute;
  const id = 'bbbbbbbb-1111-2222-3333-444444444444';
  const slot = fleet.slots[0];
  slot.status = 'online';
  fleet.clients.set(slot.index, { state: 'online', index: slot.index, close() {} });
  Actions.execute = async () => {
    throw new AppError(codes.NETWORK_ERROR, 'сеть недоступна');
  };
  try {
    Store.write(path.join(fleet.commandDir, `${id}.json`), { bot: slot.index, action: 'friends', args: {} });
    await fleet.processCommands();
    const result = Store.read(path.join(root, '.runtime', 'results', `${id}.json`));
    assert.equal(result.ok, true);
    const item = result.result[0];
    assert.equal(item.error, 'сеть недоступна');
    assert.equal(item.code, 'NETWORK_ERROR');
    assert.equal(item.kind, 'network');
    assert.equal(item.retryable, true);
  } finally {
    Actions.execute = original;
    fleet.stop();
    clean(root);
  }
});

test('Fleet: runOne отличает отказ сервера от сети и бота не в сети', async () => {
  const root = tempDir('nulls-err-fleet-runone-');
  fs.mkdirSync(path.join(root, 'accounts'), { recursive: true });
  const fleet = new Fleet(root, { count: 1 });
  const original = Actions.execute;
  try {
    const offline = await fleet.runOne(1, 'friends', {});
    assert.equal(offline.error, 'Бот ещё не вошёл');
    assert.equal(offline.code, 'STATE_ERROR');
    assert.equal(offline.kind, 'state');

    fleet.clients.set(1, { state: 'online', index: 1, close() {} });
    Actions.execute = async () => {
      throw new AppError(codes.STATE_ERROR, 'Сервер отклонил действие: пакет 24129', { kind: 'server' });
    };
    const refused = await fleet.runOne(1, 'friends', {});
    assert.equal(refused.error, 'Сервер отклонил действие: пакет 24129');
    assert.equal(refused.code, 'STATE_ERROR');
    assert.equal(refused.kind, 'server');
    assert.equal(refused.retryable, false);
  } finally {
    Actions.execute = original;
    fleet.stop();
    clean(root);
  }
});

test('Fleet: битый accounts/bot-N.json даёт slot.errorCode STORE_CORRUPT', () => {
  const root = tempDir('nulls-err-fleet-corrupt-');
  fs.mkdirSync(path.join(root, 'accounts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'accounts', 'bot-1.json'), '{');
  const fleet = new Fleet(root, { count: 1 });
  try {
    const slot = fleet.slots[0];
    assert.equal(slot.status, 'failed');
    assert.match(slot.error, /^Повреждён accounts\/bot-1\.json: /);
    assert.equal(slot.errorCode, 'STORE_CORRUPT');
    assert.equal(slot.errorKind, 'state');
  } finally {
    fleet.stop();
    clean(root);
  }
});

test('AutoUpdate: без python — PYTHON_MISSING и прежний текст', async () => {
  const childProcess = require('node:child_process');
  const platformPath = require.resolve('../utils/Platform');
  const updatePath = require.resolve('../utils/AutoUpdate');
  const savedPlatform = require.cache[platformPath];
  const savedUpdate = require.cache[updatePath];
  const originalExec = childProcess.execFileSync;
  const root = tempDir('nulls-err-update-');
  childProcess.execFileSync = () => {
    const error = new Error('spawn python3 ENOENT');
    error.code = 'ENOENT';
    throw error;
  };
  delete require.cache[platformPath];
  delete require.cache[updatePath];
  fs.writeFileSync(
    path.join(root, 'config.json'),
    JSON.stringify({
      cryptoMode: 'nulls-native19',
      clientMajor: 69,
      clientBuild: 100,
      major: 69,
      minor: 0,
      build: 100,
    }),
  );
  try {
    const AutoUpdate = require('../utils/AutoUpdate');
    await assert.rejects(
      () => AutoUpdate.runUpdate(root, { apk: path.join(root, 'base.apk') }),
      (error) => {
        assert.equal(error.code, 'PYTHON_MISSING');
        assert.equal(error.kind, 'config');
        assert.equal(error.retryable, false);
        assert.match(error.message, /python3/);
        return true;
      },
    );
  } finally {
    childProcess.execFileSync = originalExec;
    if (savedPlatform) require.cache[platformPath] = savedPlatform;
    else delete require.cache[platformPath];
    if (savedUpdate) require.cache[updatePath] = savedUpdate;
    else delete require.cache[updatePath];
    clean(root);
  }
});

test('toJSON не печатает passToken/token даже в details ошибки библиотеки', () => {
  const error = new AppError(codes.NETWORK_ERROR, 'обрыв для alice@example.com', {
    details: { passToken: 'secret-pass', token: 'secret-token', file: 'accounts/bot-1.json' },
  });
  const safe = toJSON(error);
  const text = JSON.stringify(safe);
  assert.ok(!text.includes('secret-pass'), text);
  assert.ok(!text.includes('secret-token'), text);
  assert.ok(!text.includes('alice@'), text);
  assert.equal(safe.details.file, 'accounts/bot-1.json');
  assert.equal(safe.code, 'NETWORK_ERROR');
  assert.equal(safe.kind, 'network');
});
