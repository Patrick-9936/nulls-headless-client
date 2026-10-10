const test=require('node:test');
const assert=require('node:assert/strict');
const NullsCrypto=require('../Crypto/NullsCrypto');
const native=require('../Crypto/NativeCryptoPrimitives');
const config=require('../config.json');
test('Nulls Login encrypts the length-prefixed server session without SDK padding',()=>{
  const c=new NullsCrypto(config), session=Buffer.alloc(24,0x11);
  const hello=Buffer.alloc(32); hello.writeInt32BE(24); session.copy(hello,4); hello.writeInt32BE(-1,28);
  assert.deepEqual(c.decrypt(config.packetIds.serverHello,hello),hello);
  const body=Buffer.from('login-body'), wire=c.encrypt(config.packetIds.login,body);
  const plain=native.boxOpen(wire.subarray(32),native.blake2b24(c.clientPublicKey,c.serverPublicKey),c.serverPublicKey,c.clientPrivateKey);
  assert.equal(plain[0],24);
  assert.deepEqual(plain.subarray(1,25),session);
  assert.deepEqual(plain.subarray(25,49),c.sendNonce.bytes());
  assert.deepEqual(plain.subarray(49),body);
});
test('Nulls rejects unsupported session lengths and Login before ServerHello',()=>{
  const c=new NullsCrypto(config), hello=Buffer.alloc(36); hello.writeInt32BE(32);
  assert.throws(()=>c.encrypt(config.packetIds.login,Buffer.alloc(0)),/No session/);
  assert.throws(()=>c.decrypt(config.packetIds.serverHello,hello),/Unsupported Nulls challenge length/);
});
