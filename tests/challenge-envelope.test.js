const test = require('node:test');
const assert = require('node:assert/strict');
const NullsCrypto = require('../Crypto/NullsCrypto');
const ModernCrypto = require('../Crypto/ModernCrypto');
const native = require('../Crypto/NativeCryptoPrimitives');
const config = require('../config.json');
function serverHello(session) {
  const hello = Buffer.alloc(32);
  hello.writeInt32BE(24);
  session.copy(hello, 4);
  hello.writeInt32BE(-1, 28);
  return hello;
}
function open(wire, c) {
  return native.boxOpen(
    wire.subarray(32),
    native.blake2b24(c.clientPublicKey, c.serverPublicKey),
    c.serverPublicKey,
    c.clientPrivateKey,
  );
}
test('Nulls Login seals [VInt len][body][clientNonce] to the static server key', () => {
  // RE-SEAL / RE-CONTAINER: the native seal gets a 65-byte plaintext for a 40-byte body,
  // i.e. no ServerHello echo and no SDK padding.
  const c = new NullsCrypto({ ...config, loginLayout: 'native' }),
    session = Buffer.alloc(24, 0x11);
  assert.deepEqual(c.decrypt(config.packetIds.serverHello, serverHello(session)), serverHello(session));
  const body = Buffer.from('login-body'),
    wire = c.encrypt(config.packetIds.login, body);
  const plain = open(wire, c);
  const len = ModernCrypto.writeVInt(body.length);
  assert.deepEqual(plain.subarray(0, len.length), len);
  assert.deepEqual(plain.subarray(len.length, len.length + body.length), body);
  assert.deepEqual(plain.subarray(len.length + body.length), c.sendNonce.bytes());
  assert.equal(plain.length, len.length + body.length + 24);
});
test('Legacy loginLayout still sends the length-prefixed server session without padding', () => {
  const c = new NullsCrypto({ ...config, loginLayout: 'hello' }),
    session = Buffer.alloc(24, 0x11);
  c.decrypt(config.packetIds.serverHello, serverHello(session));
  const body = Buffer.from('login-body'),
    wire = c.encrypt(config.packetIds.login, body);
  const plain = open(wire, c);
  assert.equal(plain[0], 24);
  assert.deepEqual(plain.subarray(1, 25), session);
  assert.deepEqual(plain.subarray(25, 49), c.sendNonce.bytes());
  assert.deepEqual(plain.subarray(49), body);
});
test('Nulls rejects unsupported session lengths and Login before ServerHello', () => {
  const c = new NullsCrypto(config),
    hello = Buffer.alloc(36);
  hello.writeInt32BE(32);
  assert.throws(() => c.encrypt(config.packetIds.login, Buffer.alloc(0)), /No session/);
  assert.throws(() => c.decrypt(config.packetIds.serverHello, hello), /Unsupported Nulls challenge length/);
});
