const ByteStream = require('../../../DataStream/ByteStream');

// Код ошибки входа -> что с этим делать. Сервер отдаёт только число, поэтому
// без подсказки пользователь видит "login failed 8" и не понимает, что делать.
const HINTS = {
  8: 'the client build or its license block is stale: client-license.bin is bound to one '
   + 'APK build and its size. Update to the latest release and re-cut the block '
   + '(docs/APK-UPDATE.md).',
  9: 'the server replied with a redirect (ServerHost). The client does not follow it automatically.',
  10: 'the server rejected the session, usually after a duplicate login of the same account.',
};

function safe(fn, fallback = null) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

module.exports = class LoginFailedMessage {
  constructor() {
    this.ByteStream = new ByteStream();
  }

  decode() {
    const s = this.ByteStream;
    this.errorCode = s.readInt();

    // Brawl's plaintext/pre-handshake 20103 keeps the older Titan-style layout:
    // error, fingerprint, serverHost, patching/contentHost, updateHost, message, ...
    this.fingerprint = safe(() => s.readOptionalString(), '');
    this.serverHost = safe(() => s.readOptionalString(), '');
    this.patchingHost = safe(() => s.readOptionalString(), '');
    this.updateHost = safe(() => s.readOptionalString(), '');
    this.message = safe(() => s.readOptionalString(), '');

    // Preserve remaining bytes for research/debugging.
    this.remaining = Buffer.from(s.payload.slice(s.offset));
    this.remainingHex = this.remaining.toString('hex');
  }

  process(messaging) {
    const phase = messaging.crypto && !messaging.crypto.sessionKey ? 'ClientHello/pre-handshake' : 'Login';
    const extra = [];
    if (this.serverHost) extra.push(`serverHost=${this.serverHost}`);
    if (this.message) extra.push(`message=${this.message}`);
    if (this.patchingHost) extra.push(`patchingHost=${this.patchingHost}`);
    if (this.updateHost) extra.push(`updateHost=${this.updateHost}`);
    if (this.remaining.length) extra.push(`tail=${this.remaining.length}B`);

    this.hint = HINTS[this.errorCode] || '';
    globalThis.Debugger?.error?.(`LoginFailed phase=${phase} error=${this.errorCode}${extra.length ? ' ' + extra.join(' ') : ''}`);
    if (this.hint) globalThis.Debugger?.warn?.(`LoginFailed error=${this.errorCode}: ${this.hint}`);

    if (this.errorCode === 9 && this.serverHost && /stage\.brawlstarsgame\.com/i.test(this.serverHost)) {
      globalThis.Debugger?.warn?.(
        'The stage.brawlstarsgame.com string is a ServerHost field in the Brawl LoginFailed layout; it is not automatically followed as a redirect.',
      );
    }

    if (this.fingerprint) {
      try {
        const fp = JSON.parse(this.fingerprint);
        if (fp.sha) messaging.config.fingerprintHash = fp.sha;
        if (fp.version) {
          const v = String(fp.version).split('.').map(Number);
          if (v.length >= 3) {
            messaging.config.major = v[0];
            messaging.config.minor = v[1];
            messaging.config.build = v[2];
          }
        }
        messaging.saveConfig();
        globalThis.Debugger?.info?.('Saved fingerprint/version from server response.');
        const server = `${v[0]}.${v[1]}.${v[2]}`;
        const client = `${messaging.config.major}.${messaging.config.minor}.${messaging.config.build}`;
        if (server !== client) {
          globalThis.Debugger?.warn?.(
            `LoginFailed version mismatch: server expects ${server}, this client sends ${client}. `
            + 'Update the client before re-cutting the license block.',
          );
        }
      } catch {
        globalThis.Debugger?.warn?.('Fingerprint field was present but was not JSON.');
      }
    }
    messaging.close('LoginFailed');
  }
};
