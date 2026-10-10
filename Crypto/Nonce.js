const Blake2b = require('blakejs');
const crypto = require('crypto');

module.exports = class Nonce {
  constructor(input) {
    if (!input) {
      this.nonce = new Uint8Array(crypto.randomBytes(24));
      return;
    }
    if (input.Keys) {
      const ctx = Blake2b.blake2bInit(24);
      if (input.nonce) Blake2b.blake2bUpdate(ctx, input.nonce);
      for (const key of input.Keys) Blake2b.blake2bUpdate(ctx, key);
      this.nonce = Blake2b.blake2bFinal(ctx);
    } else if (input.nonce) {
      this.nonce = new Uint8Array(input.nonce);
    } else {
      throw new Error('Bad Nonce input');
    }
  }
  bytes() { return this.nonce; }
  increment() {
    const temp = Buffer.from(this.nonce);
    temp.writeInt32LE(temp.readInt32LE(0) + 2, 0);
    this.nonce = new Uint8Array(temp);
  }
};
