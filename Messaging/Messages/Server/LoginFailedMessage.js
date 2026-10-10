const ByteStream = require('../../../DataStream/ByteStream');

function safe(fn, fallback=null){ try { return fn(); } catch { return fallback; } }

module.exports = class LoginFailedMessage {
  constructor() { this.ByteStream = new ByteStream(); }

  decode() {
    const s=this.ByteStream;
    this.errorCode=s.readInt();

    // Brawl's plaintext/pre-handshake 20103 keeps the older Titan-style layout:
    // error, fingerprint, serverHost, patching/contentHost, updateHost, message, ...
    this.fingerprint=safe(()=>s.readOptionalString(),'');
    this.serverHost=safe(()=>s.readOptionalString(),'');
    this.patchingHost=safe(()=>s.readOptionalString(),'');
    this.updateHost=safe(()=>s.readOptionalString(),'');
    this.message=safe(()=>s.readOptionalString(),'');

    // Preserve remaining bytes for research/debugging.
    this.remaining=Buffer.from(s.payload.slice(s.offset));
    this.remainingHex=this.remaining.toString('hex');
  }

  process(messaging) {
    const phase = messaging.crypto && !messaging.crypto.sessionKey ? 'ClientHello/pre-handshake' : 'Login';
    const extra=[];
    if(this.serverHost) extra.push(`serverHost=${this.serverHost}`);
    if(this.message) extra.push(`message=${this.message}`);
    if(this.patchingHost) extra.push(`patchingHost=${this.patchingHost}`);
    if(this.updateHost) extra.push(`updateHost=${this.updateHost}`);
    if(this.remaining.length) extra.push(`tail=${this.remaining.length}B`);

    Debugger.error(`LoginFailed phase=${phase} error=${this.errorCode}${extra.length ? ' ' + extra.join(' ') : ''}`);

    if (this.errorCode===9 && this.serverHost && /stage\.brawlstarsgame\.com/i.test(this.serverHost)) {
      Debugger.warn('The stage.brawlstarsgame.com string is a ServerHost field in the Brawl LoginFailed layout; it is not automatically followed as a redirect.');
    }

    if (this.fingerprint) {
      try {
        const fp = JSON.parse(this.fingerprint);
        if (fp.sha) messaging.config.fingerprintHash = fp.sha;
        if (fp.version) {
          const v = String(fp.version).split('.').map(Number);
          if (v.length >= 3) { messaging.config.major=v[0]; messaging.config.minor=v[1]; messaging.config.build=v[2]; }
        }
        messaging.saveConfig();
        Debugger.info('Saved fingerprint/version from server response.');
      } catch {
        Debugger.warn('Fingerprint field was present but was not JSON.');
      }
    }
    messaging.close('LoginFailed');
  }
};
