const zlib = require('node:zlib');
const ByteStream = require('../../../DataStream/ByteStream');

// LoginOk на Nulls 69.252 (снято с живого сервера, два пакета, см.
// tests/fixtures/login-ok-69.bin и docs/PROTOCOL-MAP.md). Раскладка «nulls-69»
// плоская, без VInt-заголовка: 32-битные id, потом строки с 4-байтной длиной.
// В конце пакета лежит zlib-поток (маркер 78 9c) с JWT Nulls Connect — именно
// поэтому поиск токена в открытом ASCII в 0.3.0 не находил его на живом сервере.
const ZLIB_MAGIC = 0x78;
const ZLIB_HEADER = 0x9c;
const MAX_INFLATE_BYTES = 8192;
const MAX_TOKEN_LENGTH = 4096;
const MAX_URL_COUNT = 8;
const MAX_SCAN_AHEAD = 16;

const JWT_PATTERN = /^eyJ[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}$/;
const JWT_SCAN_PATTERN = /eyJ[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}/g;

function isBindToken(value) {
  if (typeof value !== 'string') return false;
  const token = value.trim();
  if (!token || token.length > MAX_TOKEN_LENGTH) return false;
  return JWT_PATTERN.test(token);
}

// Claims нужны только для диагностики: bind-токен принимается и без них.
function decodeClaims(token) {
  try {
    const parsed = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function printable(value, max = 512) {
  if (typeof value !== 'string' || value.length > max) return false;
  return !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value);
}

// JWT лежит в zlib-потоке, который сервер дописывает в конец LoginOk. Поток
// последний, поэтому его длина не нужна: ищем маркер в пределах хвоста и
// проверяем распаковку. Смещение 0 — нормальный случай, остальное — запас на
// неопознанные поля между URL и токеном.
function inflateBindToken(rest) {
  if (!rest || rest.length < 8) return null;
  const offsets = [];
  if (rest[0] === ZLIB_MAGIC && rest[1] === ZLIB_HEADER) offsets.push(0);
  const limit = Math.min(rest.length - 1, MAX_SCAN_AHEAD);
  for (let i = 1; i < limit; i += 1) {
    if (rest[i] === ZLIB_MAGIC && rest[i + 1] === ZLIB_HEADER) offsets.push(i);
  }
  for (const offset of offsets) {
    let raw;
    try {
      raw = zlib.inflateSync(rest.subarray(offset), { maxOutputLength: MAX_INFLATE_BYTES });
    } catch {
      continue;
    }
    const token = raw.toString('utf8').trim();
    if (!isBindToken(token)) continue;
    return { token, claims: decodeClaims(token), frame: { offset, compressed: rest.length - offset, raw: raw.length } };
  }
  return null;
}

module.exports = class LoginOkMessage {
  constructor() {
    this.ByteStream = new ByteStream();
    this.parsed = false;
  }

  // Живая раскладка Nulls 69.252. Смещения от начала payload:
  //   0   u32 accountId.hi              8   u32 homeId.hi
  //   4   u32 accountId.lo              12  u32 homeId.lo
  //   16  string passToken              36  u64 -1 (неизвестный id)
  //   44  u32 clientMajor (69)          48  u32 contentVersion (414)
  //   52  u32 1                         56  string environment ("prod")
  //   60  u32 1   64 u32 1   68 u32 1
  //   72  string buildTag ("103121310241222")
  //   ... string serverTime, string secondaryTime, u32 0, i32 -1, string country,
  //   i32 -1, u32 1, i32 -1, u32 patchUrlCount, patchUrl..., u32 eventUrlCount,
  //   eventUrl..., u32 0, VInt tokenHint (1365/1366), u16 0, затем zlib-JWT.
  decodeNulls69() {
    const s = this.ByteStream;
    this.hi = s.readUInt32();
    this.lo = s.readUInt32();
    this.homeHi = s.readUInt32();
    this.homeLo = s.readUInt32();
    this.token = s.readString();
    if (!printable(this.token, 256)) throw new Error('passToken вне допустимой длины');
    this.unknownLong = Buffer.from(s.readBytes(8)).toString('hex');
    this.clientMajor = s.readInt();
    this.contentVersion = s.readInt();
    this.unknownOne = s.readInt();
    this.environment = s.readString();
    if (!printable(this.environment, 32)) throw new Error('environment не строка');
    this.unknownFlags = [s.readInt(), s.readInt(), s.readInt()];
    this.buildTag = s.readString();
    this.serverTime = s.readString();
    this.secondaryTime = s.readString();
    this.marker = s.readInt();
    this.unknownOptionalA = s.readInt();
    this.countryCode = s.readString();
    if (!printable(this.countryCode, 8)) throw new Error('countryCode не строка');
    this.unknownOptionalB = s.readInt();
    this.unknownCounterA = s.readInt();
    this.unknownOptionalC = s.readInt();
    const patchCount = s.readInt();
    if (patchCount < 0 || patchCount > MAX_URL_COUNT) throw new Error(`patchUrlCount ${patchCount}`);
    this.patchUrls = Array.from({ length: patchCount }, () => s.readString());
    const eventCount = s.readInt();
    if (eventCount < 0 || eventCount > MAX_URL_COUNT) throw new Error(`eventUrlCount ${eventCount}`);
    this.eventUrls = Array.from({ length: eventCount }, () => s.readString());
    this.tailZero = s.readInt();
    this.tokenHint = s.readVInt();
    this.tailPadding = Buffer.from(s.readBytes(2)).readUInt16BE(0);
    const rest = Buffer.from(s.readBytes(s.remaining()));
    this.layout = 'nulls-69';
    this.parsed = true;
    this.applyBindToken(inflateBindToken(rest));
  }

  decodeModern() {
    const s = this.ByteStream;
    this.loginResult = s.readVInt();
    this.unknown0 = s.readVInt();
    this.loginVersion = s.readVInt();
    this.serverBuild = s.readVInt();
    this.unknown1 = s.readBoolean();
    const a = s.readLong();
    this.hi = a.hi;
    this.lo = a.lo;
    this.homeId = s.readLong();
    this.creationTimestamp = s.readString();
    this.creationTimestampTrunc = s.readString();
    this.token = s.readString();
    for (let i = 0; i < 4; i++) s.readOptionalString();
    this.countryCode = s.readString();
    this.eventAssetsUrl = s.readString();
    this.parsed = true;
    this.layout = 'modern-generic';
  }

  decodeLegacy() {
    const s = this.ByteStream;
    this.hi = s.readUInt32();
    this.lo = s.readUInt32();
    s.readUInt32();
    s.readUInt32();
    this.token = s.readString();
    this.parsed = true;
    this.layout = 'legacy';
  }

  applyBindToken(found) {
    if (!found) return;
    this.bindToken = found.token;
    this.bindClaims = found.claims;
    this.bindFrame = found.frame;
  }

  decode() {
    const original = Buffer.from(this.ByteStream.payload);
    this.decodeErrors = [];
    for (const layout of ['nulls-69', 'modern-generic', 'legacy']) {
      if (this.parsed) break;
      try {
        this.ByteStream.set(original);
        if (layout === 'nulls-69') this.decodeNulls69();
        else if (layout === 'modern-generic') this.decodeModern();
        else this.decodeLegacy();
      } catch (error) {
        this.ByteStream.set(original);
        this.decodeErrors.push({ layout, message: error.message });
      }
    }
    if (!this.parsed) this.layout = undefined;
    if (this.parsed && !this.bindToken) this.extractBindToken();
    // Одна строка на пакет: входов один на соединение, а молча глотать
    // несовпадение раскладки хуже, чем шум в логе.
    if (this.decodeErrors.length) {
      const detail = this.decodeErrors.map((e) => `${e.layout}: ${e.message}`).join('; ');
      globalThis.Debugger?.warn?.(`LoginOk: разбор не удался (${detail})`);
    }
  }

  // Запасной путь для будущих раскладок: сначала хвост как zlib (токен может
  // быть сжат при любой схеме полей), потом ASCII-поиск незашифрованного JWT.
  extractBindToken() {
    const s = this.ByteStream;
    const start = s.offset;
    const rest = Buffer.from(s.payload.slice(start));
    this.applyBindToken(inflateBindToken(rest));
    if (this.bindToken) return;

    const text = rest.toString('latin1');
    JWT_SCAN_PATTERN.lastIndex = 0;
    let match;
    while ((match = JWT_SCAN_PATTERN.exec(text))) {
      if (match[0].length > MAX_TOKEN_LENGTH) continue;
      if (!isBindToken(match[0])) continue;
      this.bindToken = match[0];
      this.bindClaims = decodeClaims(this.bindToken);
      return;
    }
  }

  process(messaging) {
    if (this.parsed) {
      messaging.account.hi = this.hi;
      messaging.account.lo = this.lo;
      if (this.token) {
        messaging.account.passToken = this.token;
        messaging.account.token = this.token;
      }
      if (this.bindToken) {
        messaging.account.bindToken = { token: this.bindToken, at: new Date().toISOString() };
        // Сам токен не логируем: достаточно размера и срока из claims.
        const exp = this.bindClaims?.exp ? `, exp=${new Date(this.bindClaims.exp * 1000).toISOString()}` : '';
        globalThis.Debugger?.info?.(`LoginOk: bind-token найден (${this.bindToken.length} символов${exp})`);
      }
      messaging.saveAccount();
      globalThis.Debugger?.info?.(`Login OK (${this.layout}): account=${this.hi}:${this.lo}`);
    } else {
      globalThis.Debugger?.warn?.(
        'LoginOk packet recognized, but its payload layout was not decoded. Raw packet can be saved with --dump.',
      );
    }
    messaging.onLoggedIn();
  }
};
