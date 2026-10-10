const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const Hello=require('../Messaging/Messages/Client/ModernClientHelloMessage');
const Login=require('../Messaging/Messages/Client/LoginMessage');
const base=require('../config.json');
const root=path.resolve(__dirname,'..');
const license=fs.readFileSync(path.join(root,'client-license.bin'));
const config=()=>require('../utils/NullsLicense').apply({...base},root);
function readHello(c){const h=new Hello(c);h.encode();const s=h.ByteStream;s.set(s.getBytes());return s;}
test('Nulls Hello includes the APK version, authentic license and current metadata',()=>{
  const s=readHello(config());
  assert.deepEqual(Array.from({length:5},()=>s.readInt()),[2,59,69,0,252]);
  assert.equal(s.readOptionalString(),base.fingerprintHash);
  assert.equal(s.readInt(),2);assert.equal(s.readInt(),2);
  const n=s.readInt(), extra=Buffer.from(s.payload.subarray(s.offset,s.offset+n));
  assert.equal(extra.length,n);assert.deepEqual(extra.subarray(0,license.length),license);
  assert.equal(extra.at(-1),0);
  const m=JSON.parse(extra.subarray(license.length,-1).toString());
  assert.deepEqual(m.features,['high_memory']);assert.deepEqual(m.modificationIds,[]);
  assert.equal(m.connection,'Keep-Alive');assert.ok(Math.abs(Date.now()-m.timestamp)<10000);
  assert.equal(s.offset+n,s.payload.length);
});
test('Downloadable content updates preserve the Hello APK tuple',()=>{
  const s=readHello({...config(),major:70,minor:999,build:1});
  s.readInt();s.readInt();assert.deepEqual([s.readInt(),s.readInt(),s.readInt()],[69,0,252]);
});
test('Nulls Login preserves the saved token and includes the APK size seed',()=>{
  const c=config(), l=new Login(c,{passToken:'test-token'});l.encode();const s=l.ByteStream;s.set(s.getBytes());
  s.readLong();assert.equal(s.readOptionalString(),'test-token');
  assert.deepEqual([s.readInt(),s.readInt(),s.readInt()],[69,1,252]);
  assert.equal(s.readOptionalString(),c.fingerprintHash);s.readOptionalString();s.readVInt();s.readVInt();
  s.readOptionalString();s.readOptionalString();s.readBoolean();s.readOptionalString();s.readOptionalString();
  s.readBoolean();s.readOptionalString();assert.equal(s.readInt(),1448);
  assert.equal(s.readVInt(),(1267993744^4330295)|0);
  assert.equal(s.readOptionalString(),'69.252');
});
test('Login frame uses version 10 and Hello uses version 0',()=>{
  const Messaging=require('../Messaging/Messaging'), chunks=[];
  const m=new Messaging({write:b=>chunks.push(Buffer.from(b))},null,{config:config(),account:{}});
  m.crypto={encrypt:(_id,b)=>b};const old=global.Debugger;global.Debugger={info(){},error:msg=>assert.fail(msg)};
  try{m.send(base.packetIds.login,Buffer.from([0]));assert.equal(chunks[0].readUInt16BE(5),10);
    m.send(base.packetIds.clientHello,Buffer.from([0]));assert.equal(chunks[2].readUInt16BE(5),0);
  }finally{global.Debugger=old;}
});
