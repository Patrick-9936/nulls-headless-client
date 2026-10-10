// Crypto primitives for the v69 protocol.
const nacl = require('./NaClNative19');
const {blake2b} = require('blakejs');
const u8 = b => new Uint8Array(b);
module.exports = {
  scalarMultBase: key => Buffer.from(nacl.scalarMult.base(u8(key))),
  blake2b24: (...parts) => Buffer.from(blake2b(Buffer.concat(parts.map(b => Buffer.from(b))), null, 24)),
  box: (message, nonce, publicKey, privateKey) => Buffer.from(nacl.box(u8(message), u8(nonce), u8(publicKey), u8(privateKey))),
  boxOpen: (message, nonce, publicKey, privateKey) => {
    const result = nacl.box.open(u8(message), u8(nonce), u8(publicKey), u8(privateKey));
    return result ? Buffer.from(result) : null;
  },
  secretBox: (message, nonce, key) => Buffer.from(nacl.secretbox(u8(message), u8(nonce), u8(key))),
  secretBoxOpen: (message, nonce, key) => {
    const result = nacl.secretbox.open(u8(message), u8(nonce), u8(key));
    return result ? Buffer.from(result) : null;
  },
};
