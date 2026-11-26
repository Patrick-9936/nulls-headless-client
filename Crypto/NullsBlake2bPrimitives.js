'use strict';
// v70 "blake2b box" — reconstruction of Null's custom symmetric core.
//
// WHAT IS CONFIRMED (from emulating the stock arm64 libg.so, see
// docs/V70-LOGIN-STATUS-HONEST.md):
//   * DH is STANDARD X25519 (shared = X25519(csk, serverPublicKey) was found
//     byte-for-byte in the emulator's memory).
//   * blake2b is STANDARD (reference IV), called in the cipher with
//     digest_size=24 over nonce(24) || key(64).
//   * envelope = clientPublicKey(32) || MAC(16) || ciphertext(len).
//   * There is NO salsa20/poly1305/chacha anywhere in libg.so, so the stock
//     tweetnacl crypto_box is the wrong symmetric core — this file replaces it.
//
// WHAT IS A HYPOTHESIS (the exact keystream/MAC assembly could not be observed
// purely statically — the real keystream only engages with the game's runtime
// object graph). The 24-byte blake2b(nonce||key) that WAS observed fits a
// 24-byte keystream block, so the keystream here is built as
//   ks_i = blake2b(nonce(24) || key64(64) || counter(i), 24)
// concatenated to the message length. The uncertain choices (how the 64-byte
// box key is derived from the X25519 shared secret, how the counter is encoded,
// and what the MAC covers) are exposed as options so they can be swept against
// the live server with tools/login-probe.js without editing code.
//
// Select with config.cryptoMode === 'nulls-blake2b'. The sweepable knobs live
// under config.b2b = { keyKdf, counter, macInput, macKey }.

const nacl = require('./NaClNative19');
const { blake2b } = require('blakejs');

const U8 = (b) => (b instanceof Uint8Array ? b : new Uint8Array(Buffer.from(b)));
const cat = (...parts) => Buffer.concat(parts.map((p) => Buffer.from(p)));

function x25519(sk, pk) {
  return Buffer.from(nacl.scalarMult(U8(sk), U8(pk)));
}

// --- the configurable pieces -------------------------------------------------

// 64-byte box key from the 32-byte X25519 shared secret.
function deriveKey64(shared, opt) {
  switch (opt) {
    case 'shared_dup': // shared || shared
      return cat(shared, shared);
    case 'shared_zero': // shared || zeros
      return cat(shared, Buffer.alloc(32));
    case 'blake2b64': // blake2b(shared, 64)  (NaCl-beforenm analog)
    default:
      return Buffer.from(blake2b(U8(shared), null, 64));
  }
}

function counterBytes(i, opt) {
  switch (opt) {
    case 'none':
      return Buffer.alloc(0);
    case 'u8':
      return Buffer.from([i & 0xff]);
    case 'le64': {
      const b = Buffer.alloc(8);
      b.writeUInt32LE(i >>> 0, 0);
      return b;
    }
    case 'le32':
    default: {
      const b = Buffer.alloc(4);
      b.writeUInt32LE(i >>> 0, 0);
      return b;
    }
  }
}

function keystream(nonce, key64, length, opt) {
  const blockLen = 24; // matches observed digest_size=24
  const out = Buffer.alloc(Math.ceil(length / blockLen) * blockLen);
  for (let i = 0, off = 0; off < out.length; i++, off += blockLen) {
    const blk = Buffer.from(blake2b(U8(cat(nonce, key64, counterBytes(i, opt))), null, blockLen));
    blk.copy(out, off);
  }
  return out.subarray(0, length);
}

function mac(nonce, key64, ct, opt, macKeyOpt) {
  const key = macKeyOpt === 'keyed' ? U8(key64.subarray(0, 32)) : null;
  let data;
  switch (opt) {
    case 'ct':
      data = Buffer.from(ct);
      break;
    case 'key_nonce_ct':
      data = cat(key64, nonce, ct);
      break;
    case 'nonce_ct':
    default:
      data = cat(nonce, ct);
      break;
  }
  return Buffer.from(blake2b(U8(data), key, 16));
}

function seal(message, nonce, key64, cfg) {
  const ct = Buffer.from(message);
  const ks = keystream(nonce, key64, ct.length, cfg.counter);
  for (let i = 0; i < ct.length; i++) ct[i] ^= ks[i];
  const tag = mac(nonce, key64, ct, cfg.macInput, cfg.macKey);
  return cat(tag, ct);
}

function open(boxed, nonce, key64, cfg) {
  const b = Buffer.from(boxed);
  if (b.length < 16) return null;
  const tag = b.subarray(0, 16);
  const ct = b.subarray(16);
  const expect = mac(nonce, key64, ct, cfg.macInput, cfg.macKey);
  if (!tag.equals(expect)) return null;
  const pt = Buffer.from(ct);
  const ks = keystream(nonce, key64, pt.length, cfg.counter);
  for (let i = 0; i < pt.length; i++) pt[i] ^= ks[i];
  return pt;
}

function cfgFrom(config) {
  const b = (config && config.b2b) || {};
  return {
    keyKdf: b.keyKdf || 'blake2b64',
    counter: b.counter || 'le32',
    macInput: b.macInput || 'nonce_ct',
    macKey: b.macKey || 'keyed',
  };
}

module.exports = (config) => {
  const cfg = cfgFrom(config);
  return {
    _cfg: cfg,
    scalarMultBase: (key) => Buffer.from(nacl.scalarMult.base(U8(key))),
    blake2b24: (...parts) => Buffer.from(blake2b(U8(cat(...parts)), null, 24)),
    // asymmetric box (login / first message): X25519 then blake2b seal
    box: (message, nonce, publicKey, privateKey) => {
      const key64 = deriveKey64(x25519(privateKey, publicKey), cfg.keyKdf);
      return seal(message, nonce, key64, cfg);
    },
    boxOpen: (message, nonce, publicKey, privateKey) => {
      const key64 = deriveKey64(x25519(privateKey, publicKey), cfg.keyKdf);
      return open(message, nonce, key64, cfg);
    },
    // symmetric box (session messages): key may be 32 or 64 bytes
    secretBox: (message, nonce, key) => {
      const key64 = key.length >= 64 ? Buffer.from(key) : cat(key, key).subarray(0, 64);
      return seal(message, nonce, key64, cfg);
    },
    secretBoxOpen: (message, nonce, key) => {
      const key64 = key.length >= 64 ? Buffer.from(key) : cat(key, key).subarray(0, 64);
      return open(message, nonce, key64, cfg);
    },
  };
};
