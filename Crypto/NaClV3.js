// Modern Supercell NaCl-v3 style primitives.
// Curve25519 comes from tweetnacl; the non-standard HChaCha/ChaCha round counts
// and Poly1305 layout are implemented here to match the current protocol family.
const nacl = require('tweetnacl');
const blake = require('blakejs');

const MASK128 = (1n << 128n) - 1n;
const P1305 = (1n << 130n) - 5n;
const CLAMP = 0x0ffffffc0ffffffc0ffffffc0fffffffn;

function u32(x) { return x >>> 0; }
function rotl32(x, n) { return u32((x << n) | (x >>> (32 - n))); }
function readU32LE(b, o) { return u32(b[o] | (b[o+1] << 8) | (b[o+2] << 16) | (b[o+3] << 24)); }
function writeU32LE(b, o, v) {
  v >>>= 0;
  b[o] = v & 0xff; b[o+1] = (v >>> 8) & 0xff; b[o+2] = (v >>> 16) & 0xff; b[o+3] = (v >>> 24) & 0xff;
}
function concat(...parts) { return Buffer.concat(parts.map(x => Buffer.from(x))); }

function quarter(s, a, b, c, d) {
  s[a] = u32(s[a] + s[b]); s[d] ^= s[a]; s[d] = rotl32(s[d], 16);
  s[c] = u32(s[c] + s[d]); s[b] ^= s[c]; s[b] = rotl32(s[b], 12);
  s[a] = u32(s[a] + s[b]); s[d] ^= s[a]; s[d] = rotl32(s[d], 8);
  s[c] = u32(s[c] + s[d]); s[b] ^= s[c]; s[b] = rotl32(s[b], 7);
}

function doubleRounds(s, count) {
  for (let i = 0; i < count; i++) {
    quarter(s, 0,4,8,12); quarter(s, 1,5,9,13); quarter(s, 2,6,10,14); quarter(s, 3,7,11,15);
    quarter(s, 0,5,10,15); quarter(s, 1,6,11,12); quarter(s, 2,7,8,13); quarter(s, 3,4,9,14);
  }
}

const SIGMA = Uint32Array.from([0x61707865, 0x3320646e, 0x79622d32, 0x6b206574]);

function hchacha20(key, nonce16) {
  key = Buffer.from(key); nonce16 = Buffer.from(nonce16);
  if (key.length !== 32 || nonce16.length !== 16) throw new Error('HChaCha20 expects key=32, nonce=16');
  const s = new Uint32Array(16);
  s.set(SIGMA, 0);
  for (let i=0;i<8;i++) s[4+i] = readU32LE(key, i*4);
  for (let i=0;i<4;i++) s[12+i] = readU32LE(nonce16, i*4);
  doubleRounds(s, 17);
  const out = Buffer.alloc(32);
  for (let i=0;i<4;i++) writeU32LE(out, i*4, s[i]);
  for (let i=0;i<4;i++) writeU32LE(out, 16+i*4, s[12+i]);
  return out;
}

function chacha20Block(key, counter, nonce8) {
  key = Buffer.from(key); nonce8 = Buffer.from(nonce8);
  if (key.length !== 32 || nonce8.length !== 8) throw new Error('ChaCha block expects key=32, nonce=8');
  const initial = new Uint32Array(16);
  initial.set(SIGMA,0);
  for (let i=0;i<8;i++) initial[4+i] = readU32LE(key, i*4);
  const ctr = BigInt(counter);
  initial[12] = Number(ctr & 0xffffffffn) >>> 0;
  initial[13] = Number((ctr >> 32n) & 0xffffffffn) >>> 0;
  initial[14] = readU32LE(nonce8,0);
  initial[15] = readU32LE(nonce8,4);
  const work = new Uint32Array(initial);
  doubleRounds(work, 8);
  const out = Buffer.alloc(64);
  for (let i=0;i<16;i++) writeU32LE(out, i*4, u32(work[i] + initial[i]));
  return out;
}

function leToBigInt(buf) {
  let x=0n;
  const b=Buffer.from(buf);
  for (let i=b.length-1;i>=0;i--) x=(x<<8n)|BigInt(b[i]);
  return x;
}
function bigIntToLE(x, length) {
  const out=Buffer.alloc(length);
  for (let i=0;i<length;i++) { out[i]=Number(x & 0xffn); x >>= 8n; }
  return out;
}

function poly1305(message, key32) {
  const key = Buffer.from(key32), msg = Buffer.from(message);
  if (key.length !== 32) throw new Error('Poly1305 key must be 32 bytes');
  const r = leToBigInt(key.subarray(0,16)) & CLAMP;
  const s = leToBigInt(key.subarray(16,32));
  let acc = 0n;
  for (let off=0; off<msg.length; off+=16) {
    const chunk = msg.subarray(off, Math.min(off+16,msg.length));
    const n = leToBigInt(chunk) + (1n << BigInt(8*chunk.length));
    acc = ((acc + n) * r) % P1305;
  }
  return bigIntToLE((acc+s)&MASK128,16);
}

function chachaXorPadded(key, nonce8, input) {
  const src=Buffer.from(input);
  const out=Buffer.alloc(src.length);
  const block0=chacha20Block(key,0n,nonce8);
  const polyKey=block0.subarray(0,32);
  let first=Math.min(32,src.length);
  for(let i=0;i<first;i++) out[i]=src[i]^block0[32+i];
  let off=first, counter=1n;
  while(off<src.length){
    const block=chacha20Block(key,counter++,nonce8);
    const n=Math.min(64,src.length-off);
    for(let i=0;i<n;i++) out[off+i]=src[off+i]^block[i];
    off+=n;
  }
  return { out, polyKey };
}

function secretBox(plaintext, nonce24, key32) {
  nonce24=Buffer.from(nonce24); key32=Buffer.from(key32);
  if(nonce24.length!==24 || key32.length!==32) throw new Error('SecretBox expects nonce=24,key=32');
  const subKey=hchacha20(key32,nonce24.subarray(0,16));
  const {out:cipher,polyKey}=chachaXorPadded(subKey,nonce24.subarray(16,24),plaintext);
  return concat(poly1305(cipher,polyKey),cipher);
}

function secretBoxOpen(boxed, nonce24, key32) {
  const b=Buffer.from(boxed);
  if(b.length<16) return null;
  nonce24=Buffer.from(nonce24); key32=Buffer.from(key32);
  const mac=b.subarray(0,16), cipher=b.subarray(16);
  const subKey=hchacha20(key32,nonce24.subarray(0,16));
  const block0=chacha20Block(subKey,0n,nonce24.subarray(16,24));
  const expected=poly1305(cipher,block0.subarray(0,32));
  if(!require('crypto').timingSafeEqual(mac,expected)) return null;
  return chachaXorPadded(subKey,nonce24.subarray(16,24),cipher).out;
}

function sharedBeforeNm(localPrivateKey, remotePublicKey) {
  const shared=nacl.scalarMult(new Uint8Array(localPrivateKey), new Uint8Array(remotePublicKey));
  return hchacha20(Buffer.from(shared), Buffer.alloc(16));
}

function box(plaintext, nonce24, remotePublicKey, localPrivateKey) {
  const before=sharedBeforeNm(localPrivateKey,remotePublicKey);
  const subKey=hchacha20(before,Buffer.from(nonce24).subarray(0,16));
  const {out:cipher,polyKey}=chachaXorPadded(subKey,Buffer.from(nonce24).subarray(16,24),plaintext);
  return concat(poly1305(cipher,polyKey),cipher);
}
function boxOpen(boxed, nonce24, remotePublicKey, localPrivateKey) {
  const b=Buffer.from(boxed); if(b.length<16) return null;
  const before=sharedBeforeNm(localPrivateKey,remotePublicKey);
  const subKey=hchacha20(before,Buffer.from(nonce24).subarray(0,16));
  const mac=b.subarray(0,16), cipher=b.subarray(16);
  const block0=chacha20Block(subKey,0n,Buffer.from(nonce24).subarray(16,24));
  const expected=poly1305(cipher,block0.subarray(0,32));
  if(!require('crypto').timingSafeEqual(mac,expected)) return null;
  return chachaXorPadded(subKey,Buffer.from(nonce24).subarray(16,24),cipher).out;
}

function blake2b24(...parts) {
  const input=concat(...parts);
  return Buffer.from(blake.blake2b(input,null,24));
}

function scalarMultBase(privateKey) {
  return Buffer.from(nacl.scalarMult.base(new Uint8Array(privateKey)));
}

module.exports={
  hchacha20,chacha20Block,poly1305,secretBox,secretBoxOpen,box,boxOpen,blake2b24,scalarMultBase,
};
