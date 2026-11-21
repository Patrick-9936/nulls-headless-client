'use strict';
// Nulls Connect (connect.nulls.gg) HTTP client.
//
// Endpoints used here (all GET unless noted):
//   /auth/login.v2?email&game&locale[&can_register=true]        -> PIN is e-mailed
//   /auth/login.v2?email&game&locale&pin                       -> {token} bearer
//   /games/bind?bind_token&game      (Authorization: Bearer)    -> links game account
//   /games/unbind?bind_token&game    (Authorization: Bearer)    -> unlinks game account
//                                       (checked live 2026-11-21: route absent on upstream,
//                                        404 {"detail":"Not Found"} for GET/POST/DELETE/OPTIONS
//                                        -> CONNECT_UNSUPPORTED; a route that exists but has no
//                                        link answers differently -> CONNECT_NOT_LINKED)
//   /games/links?game                (Authorization: Bearer)    -> linked accounts
//   /games/token?player_id&game      (Authorization: Bearer)    -> per-player game token
// profiles.dnull.xyz:
//   GET  /:game/:key?lookup_type=GameAccountId                  -> public profile
//   POST /update?handle&image_ref               (player token)  -> edit own profile
//
// The bearer token is the Nulls Connect identity token. The bind_token is the JWT
// the game server puts into the LoginOk packet (see LoginOkMessage.bindToken).

const fs = require('node:fs');
const path = require('node:path');
const Store = require('./Store');
const { AppError } = require('./Errors');
const { version } = require('../package.json');

const DEFAULT_API_BASE = 'https://connect.nulls.gg/api';
const DEFAULT_PROFILES_BASE = 'https://profiles.dnull.xyz';
const DEFAULT_TIMEOUT_MS = 15000;
const RETRY_DELAY_MS = 250;
const MAX_RETRIES = 1;
const GAME = 'laser';
const USER_AGENT = `nulls-headless-client/${version}`;

// Default avatar image reference used by the nulls-connect-explorer when a
// profile is edited without an explicit image. Kept as a constant so callers
// can see where the magic UUID comes from.
const DEFAULT_IMAGE_REF = '83a9523b-d954-4311-a62e-3ca8971403e1';

// Bases are read once at module load; tails slashes are normalized so the
// endpoint paths below can always start with "/".
const BASE = normalizeBase(process.env.NC_API_UPSTREAM || DEFAULT_API_BASE);
const PROFILES_BASE = normalizeBase(process.env.NC_PROFILES_UPSTREAM || DEFAULT_PROFILES_BASE);

// Исторические коды ConnectError (validation/timeout/network/http/json) не меняются:
// внешние скрипты сравнивают err.code именно с ними. Новые поля kind/retryable/details
// приходят из общего контракта lib/Errors.js.
const CONNECT_META = {
  validation: { kind: 'input', retryable: false },
  timeout: { kind: 'timeout', retryable: true },
  network: { kind: 'network', retryable: true },
  http: { kind: 'server', retryable: false },
  json: { kind: 'server', retryable: false },
  auth: { kind: 'auth', retryable: false },
  // Отдельный код: вызывающая сторона должна отличать «сервер не умеет отвязку»
  // от обычной HTTP-ошибки и не выдавать её за успех.
  CONNECT_UNSUPPORTED: { kind: 'server', retryable: false },
  // Маршрут /games/unbind существует, но связи с игровым аккаунтом нет.
  // Не путать с CONNECT_UNSUPPORTED: там путь не маршрутизируется вовсе.
  CONNECT_NOT_LINKED: { kind: 'server', retryable: false },
};

class ConnectError extends AppError {
  constructor(code, message, extra = {}) {
    const meta = CONNECT_META[code] || {};
    super(code, message, {
      kind: extra.kind || meta.kind,
      retryable: extra.retryable === undefined ? meta.retryable : extra.retryable,
      details: extra.details,
      cause: extra.cause,
    });
    this.name = 'ConnectError';
    // status/data сохраняются для обратной совместимости; toJSON их не печатает.
    Object.assign(this, extra);
    if (code === 'http' && extra.retryable === undefined && Number.isFinite(extra.status)) {
      this.retryable = extra.status === 429 || extra.status >= 500;
    }
  }
}

function normalizeBase(value) {
  return String(value || '').replace(/\/+$/, '');
}

function defaultStateFile() {
  return process.env.NC_STATE_FILE || path.join(__dirname, '..', '.runtime', 'connect.json');
}

function stateFileOf(options = {}) {
  return options.stateFile || defaultStateFile();
}

function timeoutOf(options = {}) {
  const value = Number(options.timeout);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS;
}

function maskEmail(email) {
  if (typeof email !== 'string') return '***';
  const at = email.lastIndexOf('@');
  if (at < 1) return '***';
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  return `${local.slice(0, 1)}***@${domain || '***'}`;
}

function assertEmail(email) {
  if (typeof email !== 'string' || !email.trim() || !email.includes('@')) {
    throw new ConnectError('validation', 'Нужен e-mail вида user@example.com', { details: { field: 'email' } });
  }
  return email.trim();
}

function assertPin(pin) {
  const value = String(pin ?? '').trim();
  if (!/^[0-9]{4,8}$/.test(value)) {
    throw new ConnectError('validation', 'PIN — 4–8 цифр из письма', { details: { field: 'pin' } });
  }
  return value;
}

function assertBindToken(bindToken) {
  if (typeof bindToken !== 'string' || !bindToken.trim()) {
    throw new ConnectError('validation', 'Нужен bind-token из LoginOk (непустая строка)', {
      details: { field: 'bindToken' },
    });
  }
  return bindToken.trim();
}

function assertPlayerId(playerId) {
  const value = String(playerId ?? '').trim();
  if (!value) throw new ConnectError('validation', 'Нужен --player-id', { details: { field: 'playerId' } });
  return value;
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason || new Error('aborted'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason || new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// Builds a request URL without leaking the query (email, pin, bind_token) into
// error messages. Callers pass an endpoint path, never a full URL.
function buildUrl(base, endpoint, params) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== '' && value !== undefined && value !== null) query.set(key, String(value));
  }
  const url = new URL(base + endpoint);
  url.search = query.toString();
  return url;
}

function serverDetail(data) {
  if (!data || typeof data !== 'object') return '';
  const raw = data.error?.message || data.error || data.message || data.detail;
  if (typeof raw !== 'string' || !raw) return '';
  return `: ${raw.slice(0, 200)}`;
}

// Ответ FastAPI-роутера на неизвестный путь: 404 + {"detail":"Not Found"}.
// Живая проверка 2026-11-21: /games/unbind отвечает ровно так на GET, POST,
// DELETE и OPTIONS без Authorization и с невалидным Bearer — то есть путь не
// зарегистрирован, а не «связи нет». Существующие маршруты (/games/bind,
// /games/links, /games/token) на тот же запрос отдают 403
// {"detail":"Not authenticated"}, а с битым bearer — 403
// {"detail":"Invalid authentication credentials"} — тело другое.
// Поэтому «нет маршрута» — это 404 с типовым телом роутера или не-JSON тело;
// 404 с собственным сообщением сервера считается «маршрут есть, связи нет».
const ROUTE_MISS_TEXT = /^not\s+found\.?$/i;

function bodyText(data) {
  if (typeof data === 'string') return data;
  if (!data || typeof data !== 'object') return '';
  const raw = data.detail ?? data.error?.message ?? data.error ?? data.message;
  return typeof raw === 'string' ? raw : '';
}

function isRouteMiss(data) {
  const text = bodyText(data);
  // Пустое тело на 404 тоже не подтверждает существование маршрута.
  if (!text) return true;
  // Не-JSON (HTML прокси, пустая строка) — не ответ приложения.
  if (typeof data === 'string') return true;
  return ROUTE_MISS_TEXT.test(text.trim());
}

// Тела, которыми сервер сообщает «связи нет», а не «путь не найден».
// Проверка намеренно узкая: обычная 400 про неверный bind-token сюда не попадает.
const NOT_LINKED_TEXT = /not\s*linked|no\s+link|link(?:ed)?\s+(?:not\s+found|missing)|связ[а-я]*\s+не\s+найден/i;

function isNotLinked(data) {
  const text = bodyText(data);
  return !!text && !ROUTE_MISS_TEXT.test(text.trim()) && NOT_LINKED_TEXT.test(text);
}

async function readBody(response, endpoint) {
  let text;
  try {
    text = await response.text();
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new ConnectError('timeout', `${endpoint}: таймаут при чтении ответа`, { details: { endpoint } });
    }
    throw new ConnectError('network', `${endpoint}: ответ оборвался (${error?.message || error})`, {
      cause: error,
      details: { endpoint },
    });
  }
  if (!text) return null;
  const contentType = response.headers?.get?.('content-type') || '';
  if (contentType.includes('json')) {
    try {
      return JSON.parse(text);
    } catch {
      throw new ConnectError('json', `${endpoint}: сервер обещал JSON, но отдал другое`, {
        status: response.status,
        details: { endpoint, status: response.status },
      });
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function attempt(endpoint, params, { base, method, token, body, timeoutMs, signal }) {
  const url = buildUrl(base, endpoint, params);
  const headers = { accept: 'application/json', 'user-agent': USER_AGENT };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal || AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new ConnectError('timeout', `${endpoint}: нет ответа за ${timeoutMs} мс`, {
        cause: error,
        details: { endpoint, timeoutMs },
      });
    }
    throw new ConnectError('network', `${endpoint}: сеть недоступна (${error?.message || error})`, {
      cause: error,
      details: { endpoint },
    });
  }
  const data = await readBody(response, endpoint);
  if (response.status < 200 || response.status >= 300) {
    throw new ConnectError('http', `${endpoint}: HTTP ${response.status}${serverDetail(data)}`, {
      status: response.status,
      data,
      details: { endpoint, status: response.status },
    });
  }
  return { status: response.status, data };
}

// retry is opt-in and only ever applies to GET requests that failed on the
// network layer (never on timeout/http/json). One retry at most.
async function call(endpoint, params = {}, options = {}) {
  const { method = 'GET', token = null, body, base = BASE, timeoutMs = DEFAULT_TIMEOUT_MS, retry = false } = options;
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    return await attempt(endpoint, params, { base, method, token, body, timeoutMs, signal });
  } catch (error) {
    if (retry && method === 'GET' && error?.code === 'network') {
      let attempts = 0;
      while (attempts < MAX_RETRIES) {
        attempts++;
        try {
          await delay(RETRY_DELAY_MS, signal);
        } catch (reason) {
          throw new ConnectError('timeout', `${endpoint}: таймаут перед повтором`, {
            cause: reason,
            details: { endpoint, timeoutMs },
          });
        }
        try {
          return await attempt(endpoint, params, { base, method, token, body, timeoutMs, signal });
        } catch (next) {
          if (next?.code !== 'network' || attempts >= MAX_RETRIES) throw next;
        }
      }
    }
    throw error;
  }
}

function readState(file) {
  try {
    const state = Store.read(file, null);
    return state && typeof state === 'object' ? state : null;
  } catch {
    globalThis.Debugger?.warn?.('Nulls Connect: .runtime/connect.json повреждён, токен проигнорирован');
    return null;
  }
}

function saveState(file, state) {
  Store.write(file, state);
  // Store.write creates the temp file with 0600; chmod keeps the guarantee if the
  // file already existed with wider permissions.
  try {
    fs.chmodSync(file, 0o600);
  } catch {}
}

// Bearer token from an explicit argument or from the local state, never logged.
function tokenOf(explicit, options = {}) {
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();
  const state = readState(stateFileOf(options));
  return typeof state?.token === 'string' && state.token ? state.token : null;
}

// State summary without the token, for `tools/connect.js status`.
function status(options = {}) {
  const file = stateFileOf(options);
  const state = readState(file);
  return {
    stateFile: file,
    hasToken: typeof state?.token === 'string' && !!state.token,
    email: typeof state?.email === 'string' ? maskEmail(state.email) : null,
    at: typeof state?.at === 'string' ? state.at : null,
    game: typeof state?.game === 'string' ? state.game : null,
  };
}

// Step 1: request a PIN by e-mail. can_register=true creates the identity when
// the e-mail has no Nulls Connect account yet. No retry: the request sends mail.
async function requestPin(email, options = {}) {
  const address = assertEmail(email);
  const { locale = 'ru', game = GAME, canRegister = true } = options;
  const params = { email: address, game, locale };
  if (canRegister) params.can_register = 'true';
  return call('/auth/login.v2', params, { timeoutMs: timeoutOf(options) });
}

// Step 2: confirm the PIN. On a token in the response it is stored locally and
// the e-mail is logged masked only. No retry: the PIN attempt is stateful.
async function confirmPin(email, pin, options = {}) {
  const address = assertEmail(email);
  const code = assertPin(pin);
  const { locale = 'ru', game = GAME } = options;
  const result = await call(
    '/auth/login.v2',
    { email: address, game, locale, pin: code },
    {
      timeoutMs: timeoutOf(options),
    },
  );
  const token = result.data && typeof result.data === 'object' ? result.data.token : null;
  if (typeof token === 'string' && token) {
    saveState(stateFileOf(options), {
      email: address,
      token,
      at: new Date().toISOString(),
      game,
    });
    globalThis.Debugger?.info?.(`Nulls Connect: токен сохранён для ${maskEmail(address)}`);
  }
  return { status: result.status, data: result.data };
}

// Bind the game account (identified by the LoginOk JWT) to the Nulls Connect
// identity. Query-string form first; a few builds only answer a JSON POST on
// 404/405, so exactly one fallback is made in that case. Not retried otherwise.
async function bind(bindToken, options = {}) {
  const jwt = assertBindToken(bindToken);
  const token = tokenOf(options.token, options);
  if (!token) {
    throw new ConnectError('validation', 'Нет bearer-токена Nulls Connect: сначала выполните confirm', {
      details: { field: 'token' },
    });
  }
  const { game = GAME } = options;
  const timeoutMs = timeoutOf(options);
  try {
    return await call('/games/bind', { bind_token: jwt, game }, { token, timeoutMs });
  } catch (error) {
    if (error?.code === 'http' && (error.status === 404 || error.status === 405)) {
      return call(
        '/games/bind',
        {},
        {
          method: 'POST',
          token,
          body: { bind_token: jwt, game },
          timeoutMs,
        },
      );
    }
    throw error;
  }
}

// Unbind the game account from the Nulls Connect identity. Query-string GET
// first, then exactly one JSON POST fallback on 404/405. A 404 with the router's
// own {"detail":"Not Found"} (or an empty/non-JSON body) is treated as "route
// missing"; a 404/400 that speaks about a missing link is CONNECT_NOT_LINKED.
// Live check against connect.nulls.gg on 2026-11-21: /games/unbind answers
// 404 {"detail":"Not Found"} to GET, POST, DELETE and OPTIONS, with and without
// Authorization — the endpoint does not exist on the current upstream, so both
// requests miss and the caller gets CONNECT_UNSUPPORTED.
async function unbind(bindToken, options = {}) {
  const jwt = assertBindToken(bindToken);
  const token = tokenOf(options.token, options);
  if (!token) {
    throw new ConnectError('validation', 'Нет bearer-токена Nulls Connect: сначала выполните confirm', {
      details: { field: 'token' },
    });
  }
  const { game = GAME } = options;
  const timeoutMs = timeoutOf(options);
  const endpoint = '/games/unbind';
  const unsupported = (getStatus, postStatus, note) =>
    new ConnectError(
      'CONNECT_UNSUPPORTED',
      `Сервер не поддерживает отвязку: ${note} (GET ${getStatus}, POST ${postStatus})`,
      {
        status: postStatus,
        details: { endpoint, getStatus, postStatus },
      },
    );
  const notLinked = (status, data) =>
    new ConnectError(
      'CONNECT_NOT_LINKED',
      `Связь с игровым аккаунтом не найдена: ${endpoint} ответил HTTP ${status}${serverDetail(data)}`,
      { status, data, details: { endpoint, status } },
    );

  let getStatus = null;
  try {
    return await call(endpoint, { bind_token: jwt, game }, { token, timeoutMs });
  } catch (error) {
    getStatus = error?.status ?? null;
    if (error?.code !== 'http') throw error;
    // 501 — «не реализовано»: POST не поможет.
    if (error.status === 501) throw unsupported(501, 501, 'эндпоинт вернул HTTP 501');
    // 401/403 — маршрут есть, но bearer не принят: это не «нет маршрута».
    if (error.status === 401 || error.status === 403) throw error;
    if (error.status === 404) {
      if (!isRouteMiss(error.data)) throw notLinked(404, error.data);
      // Типовой 404 роутера: путь, скорее всего, не зарегистрирован. Один POST
      // всё равно отправляется — некоторые сборки принимают только его, и это
      // ровно один лишний запрос, не цикл. Если и POST промахнётся, ниже будет
      // CONNECT_UNSUPPORTED.
    } else if (error.status !== 405) {
      if (error.status === 400 && isNotLinked(error.data)) throw notLinked(400, error.data);
      throw error;
    }
    // 405 доказывает, что путь зарегистрирован: POST обязателен.
  }
  try {
    return await call(
      endpoint,
      {},
      {
        method: 'POST',
        token,
        body: { bind_token: jwt, game },
        timeoutMs,
      },
    );
  } catch (error) {
    if (error?.code !== 'http') throw error;
    if (error.status === 401 || error.status === 403) throw error;
    if (error.status === 404) {
      if (isRouteMiss(error.data)) throw unsupported(getStatus, 404, `маршрут ${endpoint} не принял ни GET, ни POST`);
      throw notLinked(404, error.data);
    }
    if (error.status === 400 && isNotLinked(error.data)) throw notLinked(400, error.data);
    if (error.status === 405 || error.status === 501)
      throw unsupported(getStatus, error.status, `маршрут ${endpoint} не принял ни GET, ни POST`);
    throw error;
  }
}

// Linked game accounts. Read-only, so one network retry is allowed.
async function links(options = {}) {
  const token = tokenOf(options.token, options);
  if (!token)
    throw new ConnectError('validation', 'Нет bearer-токена Nulls Connect: сначала выполните confirm', {
      details: { field: 'token' },
    });
  const { game = GAME } = options;
  return call('/games/links', { game }, { token, timeoutMs: timeoutOf(options), retry: true });
}

// Per-player game token. Read-only, so one network retry is allowed. The caller
// is responsible for not printing the token.
async function gameToken(playerId, options = {}) {
  const id = assertPlayerId(playerId);
  const token = tokenOf(options.token, options);
  if (!token)
    throw new ConnectError('validation', 'Нет bearer-токена Nulls Connect: сначала выполните confirm', {
      details: { field: 'token' },
    });
  const { game = GAME } = options;
  return call('/games/token', { player_id: id, game }, { token, timeoutMs: timeoutOf(options), retry: true });
}

// Public profile lookup on profiles.dnull.xyz, no auth.
async function profile(key, options = {}) {
  if (typeof key !== 'string' || !key.trim())
    throw new ConnectError('validation', 'Нужен ключ профиля', { details: { field: 'key' } });
  const { game = GAME, lookupType = 'GameAccountId' } = options;
  return call(
    `/${encodeURIComponent(game)}/${encodeURIComponent(key.trim())}`,
    { lookup_type: lookupType },
    {
      base: PROFILES_BASE,
      timeoutMs: timeoutOf(options),
      retry: true,
    },
  );
}

// Edit the bound profile. The account/connect bearer is rejected by this
// endpoint; pass the per-player token minted by gameToken().
async function updateProfile(playerToken, handle, options = {}) {
  if (typeof playerToken !== 'string' || !playerToken.trim()) {
    throw new ConnectError('validation', 'Нужен игровой токен для изменения профиля', {
      details: { field: 'playerToken' },
    });
  }
  if (typeof handle !== 'string' || !handle.trim())
    throw new ConnectError('validation', 'Нужен новый handle', { details: { field: 'handle' } });
  const { imageRef = DEFAULT_IMAGE_REF, blockFriends = null } = options;
  const params = { handle: handle.trim(), image_ref: imageRef };
  if (blockFriends !== null) params.block_friends = String(blockFriends);
  return call('/update', params, {
    method: 'POST',
    token: playerToken.trim(),
    body: {},
    base: PROFILES_BASE,
    timeoutMs: timeoutOf(options),
  });
}

// Removes only local credentials; it does not revoke the server-side token.
function logout(options = {}) {
  const file = stateFileOf(options);
  const existed = fs.existsSync(file);
  fs.rmSync(file, { force: true });
  if (existed) globalThis.Debugger?.info?.('Nulls Connect: локальный токен удалён');
  return { stateFile: file, removed: existed };
}

module.exports = {
  ConnectError,
  requestPin,
  confirmPin,
  tokenOf,
  bind,
  unbind,
  links,
  gameToken,
  profile,
  updateProfile,
  logout,
  status,
  maskEmail,
  DEFAULT_IMAGE_REF,
  BASE,
  PROFILES_BASE,
  GAME,
};
