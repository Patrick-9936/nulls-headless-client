const zlib = require('node:zlib');
const ByteStream = require('../../../DataStream/ByteStream');

// LoginOk на Nulls 69.252 (снято с живого сервера, 8 пакетов, см.
// tests/fixtures/login-ok-69.bin и docs/PROTOCOL-MAP.md). Раскладка «nulls-69»
// плоская, без VInt-заголовка: 32-битные id, потом строки с 4-байтной длиной.
// В конце пакета лежит «сжатая строка» с JWT Nulls Connect: VInt mode, int32 BE
// длина blob, blob = u32 LE длина распакованного + zlib-поток (маркер 78 9c).
// Именно поэтому поиск токена в открытом ASCII в 0.3.0 не находил его на живом
// сервере. Раскладка хвоста разобрана по декодеру LoginOk в libg.so (0xf2cd80).
const ZLIB_MAGIC = 0x78;
const ZLIB_HEADER = 0x9c;
const MAX_INFLATE_BYTES = 8192;
const MAX_TOKEN_LENGTH = 4096;
const MAX_URL_COUNT = 8;
const MAX_SCAN_AHEAD = 16;
// Верхняя граница буфера «сжатая строка» с JWT: 4 байта длины + zlib-поток.
const MAX_TOKEN_BLOB = 4096;

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

// Запасной путь: длина и смещение blob из раскладки не сошлись или хвост
// обрезан — ищем маркер 78 9c в пределах хвоста и проверяем распаковку.
// Смещение 0 — нормальный случай для будущих раскладок без заголовка.
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
  //   16  string passToken              40  2 × optional string (обе -1)
  //   48  u32 clientMajor (69)          52  u32 contentVersion (414)
  //   56  u32 1                         60  string environment ("prod")
  //   68  u32 1   72 u32 1   76 u32 1
  //   80  string buildTag ("103121310241222")
  //   ... string serverTime, string secondaryTime, u32 0, i32 -1, string country,
  //   i32 -1, u32 1, i32 -1, u32 patchUrlCount, patchUrl..., u32 eventUrlCount,
  //   eventUrl..., VInt tokenBlobMode, i32 tokenBlobLength, blob:
  //   u32 LE tokenRawLength + zlib-поток с JWT.
  decodeNulls69() {
    const s = this.ByteStream;
    this.hi = s.readUInt32();
    this.lo = s.readUInt32();
    this.homeHi = s.readUInt32();
    this.homeLo = s.readUInt32();
    this.token = s.readString();
    if (!printable(this.token, 256)) throw new Error('passToken вне допустимой длины');
    // Декодер LoginOk в libg.so (0xf2cd80) читает здесь две строки обычным
    // readString; на проводе это 0xffffffff 0xffffffff, то есть обе отсутствуют.
    this.optionalStrings = [s.readOptionalString(), s.readOptionalString()];
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
    this.layout = 'nulls-69';
    this.parsed = true;
    let found = false;
    try {
      found = !!this.decodeBindTokenTail();
    } catch {
      found = false;
    }
    // Запасной путь: если длины хвоста не сошлись, ищем zlib-поток в остатке.
    if (!found && s.remaining() > 0) {
      this.applyBindToken(inflateBindToken(Buffer.from(s.payload.slice(s.offset))));
    }
  }

  // Хвост LoginOk после eventUrls — «сжатая строка» в терминах клиента.
  // Разобрано по декодеру LoginOk в libg.so (APK 69.252, base.apk →
  // lib/arm64-v8a/libg.so, функция 0xf2cd80, id 0x4e88 = 20104):
  //   0xf2d130  readVInt                       → поле объекта +0x154
  //   0xf2d148  bl 0x5fa58c                    → readInt(len) + readBytes(len)
  //   0x5fa69c  сборка u32 LE из первых 4 байт  → ldrh + byte2<<16 + byte3<<24
  //   0x5fa714  bl 0x1183cb4(dst, &size, blob+4, len-4)
  //             (0x1183b04 → 0x117e808 с версией "1.3.1" по 0x1a092e — это
  //             zlib 1.3.1 uncompress/inflateInit2_)
  // То есть blob — это [u32 LE длина распакованного][zlib-поток], а поле перед
  // ним — int32 BE длина самого blob. Восемь живых захватов: mode = 0,
  // blobLength = 4 + длина потока (148/149/151), u32 LE = 149 (длина JWT),
  // поток начинается с 78 9c. Отсюда же «VInt 1365/1366» в старой раскладке:
  // это один лишний байт смещения (readUInt32(0) вместо readVInt), из-за
  // которого 0x94/0x95/0x97 склеивались со старшим байтом длины blob.
  decodeBindTokenTail() {
    const s = this.ByteStream;
    if (s.remaining() < 5) return null;
    this.tokenBlobMode = s.readVInt();
    this.tokenBlobLength = s.readInt();
    if (this.tokenBlobLength < 4 || this.tokenBlobLength > MAX_TOKEN_BLOB) return null;
    if (this.tokenBlobLength > s.remaining()) return null;
    const blob = Buffer.from(s.readBytes(this.tokenBlobLength));
    this.tokenRawLength = blob.readUInt32LE(0);
    if (this.tokenRawLength === 0 || this.tokenRawLength > MAX_INFLATE_BYTES) return null;
    let inflated;
    try {
      inflated = zlib.inflateSync(blob.subarray(4), { maxOutputLength: MAX_INFLATE_BYTES });
    } catch {
      return null;
    }
    this.tokenInflatedLength = inflated.length;
    if (inflated.length !== this.tokenRawLength) {
      globalThis.Debugger?.warn?.(
        `LoginOk: длина JWT не совпала с заголовком (${inflated.length} != ${this.tokenRawLength})`,
      );
      return null;
    }
    const token = inflated.toString('utf8').trim();
    if (!isBindToken(token)) return null;
    this.applyBindToken({
      token,
      claims: decodeClaims(token),
      frame: { offset: 4, blob: blob.length, compressed: blob.length - 4, raw: inflated.length },
    });
    return this.bindToken;
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
