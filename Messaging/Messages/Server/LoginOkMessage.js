const ByteStream = require('../../../DataStream/ByteStream');

// The server may append a Nulls Connect bind-token (JWT) to LoginOk. It is a
// plain ASCII "header.payload.signature" triple, but where exactly it sits is
// not fully specified: in the modern layout it follows the already-decoded
// country/asset fields as an extra length-prefixed string, in the legacy layout
// it follows the session token. The search below is therefore heuristic:
// a structured pass over trailing optional strings, then a bounded ASCII scan
// of whatever bytes were left over. Confirmed on a synthetic packet built from
// the decoder itself; whether the live server puts it in every layout must be
// verified against a real capture (see docs/CONNECT.md).
const JWT_PATTERN = /^eyJ[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}$/;
const JWT_SCAN_PATTERN = /eyJ[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}/g;
const MAX_TOKEN_LENGTH = 4096;
const MAX_TRAILING_STRINGS = 8;

function isBindToken(value) {
  if (typeof value !== 'string') return false;
  const token = value.trim();
  if (!token || token.length > MAX_TOKEN_LENGTH) return false;
  return JWT_PATTERN.test(token);
}

// Best effort only: the claims are useful for debugging, never required.
function decodeClaims(token) {
  try {
    const part = token.split('.')[1];
    const parsed = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

module.exports = class LoginOkMessage {
  constructor() {
    this.ByteStream = new ByteStream();
    this.parsed = false;
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

  decode() {
    const original = Buffer.from(this.ByteStream.payload);
    this.decodeErrors = [];
    this.bindToken = undefined;
    this.bindClaims = undefined;
    try {
      this.ByteStream.set(original);
      this.decodeModern();
    } catch (error) {
      this.decodeErrors.push({ layout: 'modern-generic', message: error.message });
    }
    if (!this.parsed) {
      try {
        this.ByteStream.set(original);
        this.decodeLegacy();
      } catch (error) {
        this.decodeErrors.push({ layout: 'legacy', message: error.message });
      }
    }
    if (!this.parsed) this.layout = undefined;
    if (this.parsed) this.extractBindToken();
    // One concise line per packet, never a stack trace: a login happens once
    // per connection, and silently swallowing a layout mismatch is worse.
    if (this.decodeErrors.length) {
      const detail = this.decodeErrors.map((e) => `${e.layout}: ${e.message}`).join('; ');
      Debugger.warn?.(`LoginOk: разбор не удался (${detail})`);
    }
  }

  // Looks for the bind-token in the bytes the layout decoders did not consume.
  // Leaves the ByteStream offset alone so callers can keep reading nothing.
  extractBindToken() {
    const s = this.ByteStream;
    const start = s.offset;
    const remainder = Buffer.from(s.payload.slice(start));

    // Structured pass: trailing length-prefixed optional strings.
    for (let i = 0; i < MAX_TRAILING_STRINGS && s.remaining() >= 4; i++) {
      const checkpoint = s.offset;
      try {
        const value = s.readOptionalString();
        if (isBindToken(value)) {
          this.bindToken = value.trim();
          this.bindClaims = decodeClaims(this.bindToken);
          s.offset = start;
          return;
        }
      } catch {
        s.offset = checkpoint;
        break;
      }
    }
    s.offset = start;

    // Fallback: ASCII scan of the leftover bytes. Bounded by MAX_TOKEN_LENGTH;
    // a length prefix or a binary neighbour does not stop the match.
    const text = remainder.toString('latin1');
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
        // Never log the token itself; its presence and size are enough.
        Debugger.info?.(`LoginOk: bind-token найден (${this.bindToken.length} символов)`);
      }
      messaging.saveAccount();
      Debugger.info(`Login OK (${this.layout}): account=${this.hi}:${this.lo}`);
    } else {
      Debugger.warn(
        'LoginOk packet recognized, but its v69 payload layout was not decoded. Raw packet can be saved with --dump.',
      );
    }
    messaging.onLoggedIn();
  }
};
