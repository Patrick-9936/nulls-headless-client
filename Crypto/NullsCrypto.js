const ModernCrypto = require('./ModernCrypto');

// Verified against Null's 69.252: Salsa19, a length-prefixed 24-byte
// ServerHello session value, and no official-game SDK attestation.
module.exports = class NullsCrypto extends ModernCrypto {
  constructor(config) { super({...config, cryptoMode:'native19', promonPadSize:0}); }
  decrypt(type, payload) {
    const result=super.decrypt(type,payload);
    if (type===this.config.packetIds.serverHello) {
      if (this.sessionKey.length!==24) throw new Error(`Unsupported Nulls challenge length ${this.sessionKey.length}`);
      this.setChallengeResponse(this.sessionKey);
    }
    return result;
  }
};
