'use strict';
// Единый контракт ошибок библиотек: машинный код, категория и признак повтора.
// Текст `err.message` не меняется — поля только добавляются, поэтому старые
// внешние скрипты, которые печатают/сравнивают message, продолжают работать.

const KINDS = new Set(['input', 'config', 'network', 'timeout', 'server', 'state', 'filesystem', 'auth', 'internal']);

// Каталог кодов. `kind`/`retryable` — значения по умолчанию, их можно переопределить
// в конструкторе. `value` — исторический код Connect: timeout/network/http/json/validation
// остаются прежними ради обратной совместимости, меняется только имя константы.
const CATALOG = {
  INVALID_ARGUMENT: { kind: 'input', retryable: false },
  INVALID_CONFIG: { kind: 'config', retryable: false },
  ACCOUNT_NOT_FOUND: { kind: 'state', retryable: false },
  ACCOUNT_LOCKED: { kind: 'state', retryable: true },
  STORE_CORRUPT: { kind: 'state', retryable: false },
  STATE_ERROR: { kind: 'state', retryable: false },
  PERMISSION_DENIED: { kind: 'filesystem', retryable: false },
  FILESYSTEM_ERROR: { kind: 'filesystem', retryable: false },
  NETWORK_ERROR: { kind: 'network', retryable: true },
  TIMEOUT: { kind: 'timeout', retryable: true },
  PROXY_FAILED: { kind: 'network', retryable: true },
  LICENSE_INVALID: { kind: 'auth', retryable: false },
  CONNECT_HTTP: { kind: 'server', retryable: false, value: 'http' },
  CONNECT_TIMEOUT: { kind: 'timeout', retryable: true, value: 'timeout' },
  CONNECT_NETWORK: { kind: 'network', retryable: true, value: 'network' },
  CONNECT_JSON: { kind: 'server', retryable: false, value: 'json' },
  CONNECT_VALIDATION: { kind: 'input', retryable: false, value: 'validation' },
  CONNECT_AUTH: { kind: 'auth', retryable: false, value: 'auth' },
  PLATFORM_UNSUPPORTED: { kind: 'config', retryable: false },
  PYTHON_MISSING: { kind: 'config', retryable: false },
  INTERNAL: { kind: 'internal', retryable: false },
};

const codes = Object.freeze(
  Object.fromEntries(Object.entries(CATALOG).map(([name, meta]) => [name, meta.value || name])),
);

// Индекс по значению кода и по имени константы: работает и `codes.TIMEOUT`, и строка 'TIMEOUT'.
const META = new Map();
for (const [name, meta] of Object.entries(CATALOG)) {
  META.set(meta.value || name, meta);
  META.set(name, meta);
}

const MASK = '***';
const MAX_DEPTH = 6;
const MAX_KEYS = 50;
const MAX_ITEMS = 50;
const MAX_TEXT = 512;
const SECRET_KEY =
  /^(?:pass_?token|bind_?token|token|access_?token|refresh_?token|authorization|proxy-authorization|cookie|set-cookie|password|secret|api_?key)$/i;
const EMAIL_KEY = /^e-?mail$/i;
const EMAIL_TEXT = /([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
const BEARER_TEXT = /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi;
const JWT_TEXT = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;

class AppError extends Error {
  constructor(code, message, options = {}) {
    const settings = options && typeof options === 'object' ? options : {};
    const text = message === undefined || message === null ? String(code) : String(message);
    super(text, settings.cause === undefined ? undefined : { cause: settings.cause });
    this.name = 'AppError';
    this.code = typeof code === 'string' && code ? code : codes.INTERNAL;
    const meta = META.get(this.code) || {};
    this.kind = KINDS.has(settings.kind) ? settings.kind : meta.kind || 'internal';
    this.retryable = settings.retryable === undefined ? meta.retryable === true : !!settings.retryable;
    this.details = plainDetails(settings.details);
    // Маркер нужен, если ошибка пересекла границу vm/копии модуля.
    Object.defineProperty(this, 'isAppError', { value: true, enumerable: false, configurable: true });
  }

  toJSON() {
    return serialize(this);
  }

  // Оборачивает любую ошибку, не теряя исходный message. Без явного кода
  // неизвестная ошибка становится INTERNAL (kind internal, retryable false).
  static wrap(error, code, options = {}) {
    const settings = options && typeof options === 'object' ? options : {};
    const target = code || (isAppError(error) ? error.code : codes.INTERNAL);
    const message =
      settings.message ??
      (error instanceof Error ? error.message : error === undefined || error === null ? target : String(error));
    const details = Object.assign({}, isAppError(error) ? error.details : {}, plainDetails(settings.details));
    if (isAppError(error) && error.code !== target) details.originalCode = error.code;
    if (isAppError(error) && code == null && !settings.cause && !settings.details) return error;
    return new AppError(target, message, {
      kind: settings.kind ?? (isAppError(error) ? error.kind : undefined),
      retryable: settings.retryable ?? (isAppError(error) ? error.retryable : undefined),
      details,
      cause: settings.cause === undefined ? error : settings.cause,
    });
  }
}

function plainDetails(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.assign({}, value);
}

function isAppError(value) {
  return value instanceof AppError || !!(value && value.isAppError === true);
}

function codeOf(error) {
  return isAppError(error) ? error.code : codes.INTERNAL;
}

// Приводит ошибку файловой системы к контракту, сохраняя исходный текст.
function fromFilesystem(error, details = {}) {
  if (isAppError(error)) return error;
  const errno = error && typeof error.code === 'string' ? error.code : null;
  const denied = errno === 'EACCES' || errno === 'EPERM';
  const transient = errno === 'EBUSY' || errno === 'EAGAIN' || errno === 'EMFILE' || errno === 'ENFILE';
  const message = error instanceof Error ? error.message : String(error);
  return new AppError(denied ? codes.PERMISSION_DENIED : codes.FILESYSTEM_ERROR, message, {
    cause: error,
    retryable: transient,
    details: Object.assign(errno ? { code: errno } : {}, plainDetails(details)),
  });
}

function sanitizeText(value) {
  if (value === undefined || value === null) return '';
  let text = String(value);
  text = text.replace(BEARER_TEXT, `Bearer ${MASK}`);
  text = text.replace(JWT_TEXT, MASK);
  text = text.replace(EMAIL_TEXT, (_, local, domain) => `${local.slice(0, 1)}${MASK}@${domain}`);
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
}

function maskEmail(value) {
  return typeof value === 'string' && value.includes('@') ? sanitizeText(value) : MASK;
}

function sanitizeValue(value, depth, seen) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return sanitizeText(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function' || typeof value === 'symbol') return `[${typeof value}]`;
  if (depth >= MAX_DEPTH) return '[depth]';
  if (ArrayBuffer.isView(value)) return `[binary ${value.byteLength} bytes]`;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return { name: value.name || 'Error', message: sanitizeText(value.message) };
  if (typeof value !== 'object') return sanitizeText(value);
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, MAX_ITEMS).map((item) => sanitizeValue(item, depth + 1, seen));
  const result = {};
  for (const [key, item] of Object.entries(value).slice(0, MAX_KEYS)) {
    if (SECRET_KEY.test(key)) result[key] = MASK;
    else if (EMAIL_KEY.test(key)) result[key] = maskEmail(item);
    else result[key] = sanitizeValue(item, depth + 1, seen);
  }
  return result;
}

function sanitizeDetails(details) {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return {};
  return sanitizeValue(details, 0, new WeakSet());
}

// Безопасное представление для логов: без стектрейса, токенов, паролей и e-mail.
function serialize(error) {
  if (isAppError(error)) {
    return {
      code: error.code,
      kind: error.kind,
      retryable: error.retryable === true,
      message: sanitizeText(error.message),
      details: sanitizeDetails(error.details),
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { code: codes.INTERNAL, kind: 'internal', retryable: false, message: sanitizeText(message), details: {} };
}

function toJSON(error) {
  return serialize(error);
}

module.exports = { AppError, codes, isAppError, codeOf, toJSON, fromFilesystem };
