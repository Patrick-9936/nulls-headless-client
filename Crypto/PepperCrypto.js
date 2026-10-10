const nacl = require('tweetnacl');
const Nonce = require('./Nonce');

function fromHexString(hex) {
  const clean = String(hex || '').replace(/\s+/g, '');
  if (!/^[0-9a-fA-F]{64}$/.test(clean)) throw new Error('serverPublicKeyHex must be exactly 32 bytes / 64 hex chars');
  return new Uint8Array(Buffer.from(clean, 'hex'));
}

module.exports = class PepperCrypto {
  constructor(config) {
    this.server_public_key = fromHexString(config.serverPublicKeyHex);
    const kp = nacl.box.keyPair();
    this.client_secret_key = kp.secretKey;
    this.client_public_key = kp.publicKey;
    this.key = nacl.box.before(this.server_public_key, this.client_secret_key);
    this.nonce = new Nonce({ Keys: [this.client_public_key, this.server_public_key] });
    this.client_nonce = new Nonce();
  }

  encrypt(type, payload) {
    payload = new Uint8Array(payload);
    if (type === 10100) return Buffer.from(payload);
    if (type === 10101) {
      if (!this.session_key) throw new Error('No session key yet');
      const body = Buffer.concat([Buffer.from(this.session_key), Buffer.from(this.client_nonce.bytes()), Buffer.from(payload)]);
      const boxed = nacl.box.after(new Uint8Array(body), this.nonce.bytes(), this.key);
      return Buffer.concat([Buffer.from(this.client_public_key), Buffer.from(boxed)]);
    }
    this.client_nonce.increment();
    return Buffer.from(nacl.box.after(payload, this.client_nonce.bytes(), this.key));
  }

  decrypt(type, payload) {
    payload = new Uint8Array(payload);
    if (type === 20100) {
      this.session_key = payload.slice(4, 28);
      return Buffer.from(payload);
    }
    if (type === 20104 || type === 20103) {
      if (!this.session_key) return Buffer.from(payload);
      const nonce = new Nonce({ nonce: this.client_nonce.bytes(), Keys: [this.client_public_key, this.server_public_key] });
      const opened = nacl.box.open.after(payload, nonce.bytes(), this.key);
      if (!opened) return null;
      this.server_nonce = new Nonce({ nonce: opened.slice(0, 24) });
      this.key = opened.slice(24, 56);
      return Buffer.from(opened.slice(56));
    }
    if (!this.server_nonce) return null;
    this.server_nonce.increment();
    const opened = nacl.box.open.after(payload, this.server_nonce.bytes(), this.key);
    return opened ? Buffer.from(opened) : null;
  }
};
