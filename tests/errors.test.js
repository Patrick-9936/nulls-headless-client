// Контракт ошибок: коды, категории, безопасный toJSON и интеграция в библиотеки.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { AppError, codes, isAppError, codeOf, toJSON, fromFilesystem } = require('../lib/Errors');
const Store = require('../lib/Store');
const Accounts = require('../lib/Accounts');
const Connect = require('../lib/Connect');
const NullsLicense = require('../utils/NullsLicense');

const tempDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const clean = (dir) => fs.rmSync(dir, { recursive: true, force: true });

test('AppError заполняет code/kind/retryable/details из каталога', () => {
  const error = new AppError(codes.STORE_CORRUPT, 'битый файл', { details: { file: 'index.json' } });
  assert.ok(error instanceof Error);
  assert.equal(error.name, 'AppError');
  assert.equal(error.code, 'STORE_CORRUPT');
  assert.equal(error.kind, 'state');
  assert.equal(error.retryable, false);
  assert.deepEqual(error.details, { file: 'index.json' });
  assert.equal(toJSON(error).code, 'STORE_CORRUPT');
});

test('опции конструктора переопределяют kind/retryable и сохраняют cause', () => {
  const cause = new Error('ниже по стеку');
  const error = new AppError(codes.INTERNAL, 'текст', {
    kind: 'network',
    retryable: true,
    details: { port: 1080 },
    cause,
  });
  assert.equal(error.kind, 'network');
  assert.equal(error.retryable, true);
  assert.equal(error.details.port, 1080);
  assert.equal(error.cause, cause);
});

test('AppError.wrap сохраняет message и cause, неизвестная ошибка — INTERNAL', () => {
  const cause = new Error('Сеть недоступна');
  const wrapped = AppError.wrap(cause, codes.NETWORK_ERROR, { details: { host: 'example.org' } });
  assert.equal(wrapped.message, 'Сеть недоступна');
  assert.equal(wrapped.code, 'NETWORK_ERROR');
  assert.equal(wrapped.kind, 'network');
  assert.equal(wrapped.retryable, true);
  assert.equal(wrapped.cause, cause);
  assert.equal(wrapped.details.host, 'example.org');

  const unknown = AppError.wrap(new Error('boom'));
  assert.equal(unknown.code, 'INTERNAL');
  assert.equal(unknown.kind, 'internal');
  assert.equal(unknown.retryable, false);
  assert.equal(unknown.message, 'boom');
});

test('повторный wrap не теряет исходный код, а wrap без кода возвращает ту же ошибку', () => {
  const first = AppError.wrap(new Error('таймаут'), codes.TIMEOUT);
  assert.equal(AppError.wrap(first), first);
  const second = AppError.wrap(first, codes.PROXY_FAILED, { details: { port: 1080 } });
  assert.equal(second.code, 'PROXY_FAILED');
  assert.equal(second.message, 'таймаут');
  assert.equal(second.details.originalCode, 'TIMEOUT');
  assert.equal(second.details.port, 1080);
});

test('toJSON вычищает токены, authorization и e-mail, включая вложенные объекты', () => {
  const error = new AppError(codes.NETWORK_ERROR, 'сбой для alice@example.com, Bearer abc.def', {
    details: {
      passToken: 'pass-secret',
      token: 'plain-secret',
      bindToken: 'bind-secret',
      authorization: 'Bearer auth-secret',
      email: 'alice@example.com',
      blob: Buffer.from('binary-secret'),
      nested: { token: 'nested-secret', file: 'accounts/bot-1.json' },
      items: [{ bindToken: 'array-secret' }],
    },
  });
  const safe = toJSON(error);
  const text = JSON.stringify(safe);
  for (const secret of [
    'pass-secret',
    'plain-secret',
    'bind-secret',
    'auth-secret',
    'nested-secret',
    'array-secret',
    'binary-secret',
    'alice@',
  ]) {
    assert.ok(!text.includes(secret), `toJSON не должен содержать ${secret}`);
  }
  assert.equal(safe.code, 'NETWORK_ERROR');
  assert.equal(safe.kind, 'network');
  assert.equal(safe.retryable, true);
  assert.equal(safe.details.email, 'a***@example.com');
  assert.equal(safe.details.nested.file, 'accounts/bot-1.json');
  assert.ok(!('stack' in safe));
  assert.match(safe.message, /a\*\*\*@example\.com/);
});

test('toJSON не падает на циклических details', () => {
  const error = new AppError(codes.INTERNAL, 'цикл', { details: { file: 'a.json' } });
  error.details.self = error.details;
  const safe = toJSON(error);
  assert.equal(safe.details.self, '[circular]');
  assert.equal(safe.details.file, 'a.json');
  assert.doesNotThrow(() => JSON.stringify(safe));
});

test('isAppError/codeOf: обычный Error опознаётся как INTERNAL', () => {
  const error = new AppError(codes.INVALID_ARGUMENT, 'нужен аргумент');
  assert.equal(isAppError(error), true);
  assert.equal(isAppError(new Error('plain')), false);
  assert.equal(codeOf(error), 'INVALID_ARGUMENT');
  assert.equal(codeOf(new Error('plain')), 'INTERNAL');
  assert.equal(toJSON(new Error('plain')).kind, 'internal');
  assert.deepEqual(toJSON(new Error('plain')).details, {});
});

test('fromFilesystem различает отказ доступа и общий сбой ФС, сохраняя message', () => {
  const denied = new Error('EACCES: permission denied');
  denied.code = 'EACCES';
  const deniedError = fromFilesystem(denied, { file: 'a.json' });
  assert.equal(deniedError.code, 'PERMISSION_DENIED');
  assert.equal(deniedError.kind, 'filesystem');
  assert.equal(deniedError.message, 'EACCES: permission denied');
  assert.equal(deniedError.details.code, 'EACCES');

  const broken = new Error('I/O error');
  broken.code = 'EIO';
  assert.equal(fromFilesystem(broken).code, 'FILESYSTEM_ERROR');
});

test('Store на битом JSON бросает STORE_CORRUPT с исходным message', () => {
  const dir = tempDir('nulls-errors-store-');
  const file = path.join(dir, 'broken.json');
  fs.writeFileSync(file, '{"hi": 1,');
  let parseMessage = null;
  try {
    JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    parseMessage = error.message;
  }
  try {
    assert.throws(
      () => Store.read(file),
      (error) => {
        assert.equal(error.code, 'STORE_CORRUPT');
        assert.equal(error.kind, 'state');
        assert.equal(error.retryable, false);
        assert.equal(error.details.file, file);
        assert.equal(error.details.cause, parseMessage);
        assert.equal(error.message, parseMessage);
        assert.ok(error.cause instanceof SyntaxError);
        return true;
      },
    );
  } finally {
    clean(dir);
  }
});

test('Store при отказе доступа бросает PERMISSION_DENIED и не теряет message', () => {
  const dir = tempDir('nulls-errors-perm-');
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, '{"ok": true}');
  const original = fs.readFileSync;
  fs.readFileSync = () => {
    const error = new Error('EACCES: permission denied, open state.json');
    error.code = 'EACCES';
    throw error;
  };
  try {
    assert.throws(
      () => Store.read(file),
      (error) => {
        assert.equal(error.code, 'PERMISSION_DENIED');
        assert.equal(error.kind, 'filesystem');
        assert.equal(error.message, 'EACCES: permission denied, open state.json');
        assert.equal(error.details.file, file);
        return true;
      },
    );
  } finally {
    fs.readFileSync = original;
    clean(dir);
  }
});

test('Accounts.scan оставляет битый файл записью с STORE_CORRUPT и не бросает', () => {
  const root = tempDir('nulls-errors-accounts-');
  fs.mkdirSync(path.join(root, 'accounts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'accounts', 'bot-1.json'), '{');
  fs.writeFileSync(path.join(root, 'accounts', 'bot-2.json'), JSON.stringify({ hi: 0, lo: 2 }));
  try {
    const entries = Accounts.scan(root);
    const broken = entries.find((entry) => entry.file === 'bot-1.json');
    assert.ok(broken.error);
    assert.match(broken.error, /^Повреждён JSON: /);
    assert.equal(broken.errorCode, 'STORE_CORRUPT');
    assert.ok(entries.find((entry) => entry.file === 'bot-2.json' && !entry.error));
  } finally {
    clean(root);
  }
});

test('Accounts.prune помечает файл с токеном отказом STATE_ERROR', () => {
  const root = tempDir('nulls-errors-prune-');
  fs.mkdirSync(path.join(root, 'accounts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'accounts', 'bot-1.json'), JSON.stringify({ passToken: 'secret' }));
  fs.writeFileSync(path.join(root, 'accounts', 'bot-2.json'), '{}');
  try {
    const report = Accounts.prune(root);
    const kept = report.skipped.find((item) => item.file === 'bot-1.json');
    assert.equal(kept.reason, 'pass-token');
    assert.equal(kept.code, 'STATE_ERROR');
    assert.ok(fs.existsSync(path.join(root, 'accounts', 'bot-1.json')));
  } finally {
    clean(root);
  }
});

test('Accounts.refresh на ошибке записи индекса отдаёт FILESYSTEM_ERROR', () => {
  const root = tempDir('nulls-errors-refresh-');
  fs.mkdirSync(path.join(root, 'accounts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'accounts', 'bot-1.json'), JSON.stringify({ hi: 0, lo: 1 }));
  const original = Store.write;
  Store.write = () => {
    const error = new Error('disk full');
    error.code = 'EIO';
    throw error;
  };
  try {
    assert.throws(
      () => Accounts.refresh(root),
      (error) => {
        assert.equal(error.code, 'FILESYSTEM_ERROR');
        assert.equal(error.kind, 'filesystem');
        assert.equal(error.message, 'disk full');
        assert.equal(error.details.file, Accounts.registryPath(root));
        return true;
      },
    );
  } finally {
    Store.write = original;
    clean(root);
  }
});

test('ConnectError остаётся совместимым и получает kind/retryable/details', () => {
  const timeout = new Connect.ConnectError('timeout', 'нет ответа', { details: { timeoutMs: 15000 } });
  assert.equal(timeout.name, 'ConnectError');
  assert.ok(timeout instanceof AppError);
  assert.equal(timeout.code, 'timeout');
  assert.equal(timeout.kind, 'timeout');
  assert.equal(timeout.retryable, true);
  assert.deepEqual(timeout.details, { timeoutMs: 15000 });

  const denied = new Connect.ConnectError('http', 'HTTP 401', { status: 401 });
  assert.equal(denied.code, 'http');
  assert.equal(denied.kind, 'server');
  assert.equal(denied.retryable, false);

  const unavailable = new Connect.ConnectError('http', 'HTTP 503', { status: 503 });
  assert.equal(unavailable.retryable, true);

  const invalid = new Connect.ConnectError('validation', 'нужен e-mail');
  assert.equal(invalid.kind, 'input');
  assert.equal(invalid.retryable, false);
});

test('ConnectError.toJSON не раскрывает токены, e-mail и тело ответа', () => {
  const error = new Connect.ConnectError('http', 'auth failed for alice@example.com', {
    status: 401,
    data: { token: 'server-token', email: 'alice@example.com' },
    details: { endpoint: '/auth/login.v2', status: 401 },
  });
  const text = JSON.stringify(toJSON(error));
  assert.ok(!text.includes('server-token'));
  assert.ok(!text.includes('alice@'));
  assert.match(text, /a\*\*\*@example\.com/);
  assert.equal(JSON.parse(text).details.endpoint, '/auth/login.v2');
});

test('Platform без python отдаёт PYTHON_MISSING, неизвестная возможность — PLATFORM_UNSUPPORTED', () => {
  const childProcess = require('node:child_process');
  const platformPath = require.resolve('../utils/Platform');
  const cached = require.cache[platformPath];
  const original = childProcess.execFileSync;
  childProcess.execFileSync = () => {
    const error = new Error('spawn python3 ENOENT');
    error.code = 'ENOENT';
    throw error;
  };
  delete require.cache[platformPath];
  try {
    const Platform = require('../utils/Platform');
    assert.throws(
      () => Platform.requirePython(),
      (error) => {
        assert.equal(error.code, 'PYTHON_MISSING');
        assert.equal(error.kind, 'config');
        assert.match(error.message, /python3/);
        return true;
      },
    );
    assert.throws(
      () => Platform.requireFeature('no-such-feature'),
      (error) => {
        assert.equal(error.code, 'PLATFORM_UNSUPPORTED');
        assert.equal(error.details.feature, 'no-such-feature');
        return true;
      },
    );
  } finally {
    childProcess.execFileSync = original;
    if (cached) require.cache[platformPath] = cached;
    else delete require.cache[platformPath];
  }
});

test('NullsLicense на коротком файле отдаёт LICENSE_INVALID без содержимого', () => {
  const root = tempDir('nulls-errors-license-');
  const file = path.join(root, 'client-license.bin');
  fs.writeFileSync(file, 'ABC');
  try {
    assert.throws(
      () => NullsLicense.apply({}, root),
      (error) => {
        assert.equal(error.code, 'LICENSE_INVALID');
        assert.equal(error.kind, 'auth');
        assert.equal(error.message, 'Invalid installed Nulls APK license block');
        assert.equal(error.details.file, file);
        assert.equal(error.details.expected, 58);
        assert.equal(error.details.actual, 3);
        assert.equal(error.details.reason, 'too-short');
        assert.ok(!JSON.stringify(toJSON(error)).includes('ABC'));
        return true;
      },
    );
  } finally {
    clean(root);
  }
});
