const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path');
const U=require('../utils/AutoUpdate'),I=require('../utils/LibgInspector');
function setup(){const root=fs.mkdtempSync(path.join(os.tmpdir(),'client-updater-'));const config={cryptoMode:'native19',clientMajor:69,clientBuild:252,appBinaryVersion:'69.252',major:69,minor:252,build:1,fingerprintHash:'a'.repeat(40)};
 fs.writeFileSync(path.join(root,'config.json'),JSON.stringify(config));fs.writeFileSync(path.join(root,'account.json'),'{"hi":0,"lo":123,"passToken":"fixture-token"}');
 return {root,config,read:()=>fs.readFileSync(path.join(root,'config.json'),'utf8'),clean:()=>fs.rmSync(root,{recursive:true,force:true})};}
const fingerprint={sha:'b'.repeat(40),version:'69.252.2'};
const network=verify=>({fingerprint:async()=>({status:7,fingerprint}),verify});
test('verified update keeps credentials, saves backup, and can roll back',async()=>{const s=setup(),original=s.read(),account=fs.readFileSync(path.join(s.root,'account.json'));
 try{const r=await U.runUpdate(s.root,{}, {readAPK:()=>null,network:network(async(c,a,_r,o)=>{assert.equal(s.read(),original);assert.equal(a.lo,123);assert.equal(o.helloOnly,false);assert.equal(c.fingerprintHash,fingerprint.sha);return {loginOk:true,homeData:true};})});
 assert.equal(r.status,'updated');assert.ok(fs.existsSync(path.join(s.root,r.backup)));assert.deepEqual(fs.readFileSync(path.join(s.root,'account.json')),account);await U.runUpdate(s.root,{rollback:true});assert.deepEqual(JSON.parse(s.read()),JSON.parse(original));}finally{s.clean();}});
test('check does not write config or require saved credentials',async()=>{const s=setup(),original=s.read();fs.unlinkSync(path.join(s.root,'account.json'));
 try{const r=await U.runUpdate(s.root,{check:true},{readAPK:()=>null,network:network(async(_c,a,_r,o)=>{assert.equal(a,null);assert.equal(o.helloOnly,true);return {serverHello:true};})});assert.equal(r.status,'update-available');assert.equal(s.read(),original);}finally{s.clean();}});
test('failed crypto or missing HomeData keeps config and releases lock',async()=>{for(const throwing of [true,false]){const s=setup(),original=s.read();try{
 await assert.rejects(U.runUpdate(s.root,{}, {readAPK:()=>null,network:network(async()=>{if(throwing)throw new Error('new crypto');return {loginOk:true};})}),/new crypto|not confirmed/);
 assert.equal(s.read(),original);assert.equal(fs.existsSync(path.join(s.root,'.updates/update.lock')),false);}finally{s.clean();}}});
test('concurrent edits are retained and malformed config does not leave a lock',async()=>{const s=setup();try{
 let changed;await assert.rejects(U.runUpdate(s.root,{}, {readAPK:()=>null,network:network(async()=>{changed=JSON.stringify({...s.config,port:1234});fs.writeFileSync(path.join(s.root,'config.json'),changed);return {loginOk:true,homeData:true};})}),/changed during verification/);assert.equal(s.read(),changed);
 fs.writeFileSync(path.join(s.root,'config.json'),'invalid');await assert.rejects(U.runUpdate(s.root));assert.equal(fs.existsSync(path.join(s.root,'.updates/update.lock')),false);}finally{s.clean();}});
test('resource versions do not change APK version; downgrades and invalid fingerprints are rejected',()=>{
 const c={clientMajor:70,clientBuild:100};U.fingerprintInto(c,{sha:'c'.repeat(40),version:'70.999.1'});assert.equal(c.clientBuild,100);assert.equal(c.minor,999);assert.throws(()=>U.fingerprintInto(c,{sha:'bad',version:'70.1.1'}));
 const old=U.candidateFromAPK(c,{appVersion:'69.999'},Buffer.alloc(0));assert.equal(old.installedOlder,true);assert.equal(old.config.clientMajor,70);assert.throws(()=>U.parseArgs(['--interval','0']));});
test('ARM64 keyVersion is read through a relocated GOT pointer',()=>{
 const b=Buffer.alloc(0x900);b.write('ELF',1);b[0]=0x7f;b[4]=2;b.writeUInt16LE(183,18);b.writeBigUInt64LE(64n,32);b.writeUInt16LE(56,54);b.writeUInt16LE(2,56);
 b.writeUInt32LE(1,64);b.writeUInt32LE(5,68);b.writeBigUInt64LE(BigInt(b.length),96);b.writeUInt32LE(2,120);b.writeBigUInt64LE(0x700n,128);b.writeBigUInt64LE(64n,152);
 for(let i=0;i<5;i++){b.writeUInt32LE((0xb9000001|(((0x90+4*i)/4)<<10))>>>0,0x400+i*8);b.writeUInt32LE(0xd65f03c0,0x404+i*8);}
 b.writeUInt32LE(0x90000008,0x200);b.writeUInt32LE((0xf9400000|(0x600/8)<<10|8<<5|8)>>>0,0x204);b.writeUInt32LE((0xb9400000|8<<5|1)>>>0,0x208);b.writeUInt32LE((0x94000000|((0x408-0x20c)/4))>>>0,0x20c);
 for(const [p,k,v] of [[0x700,7,0x780],[0x710,8,24],[0x720,9,24]]){b.writeBigUInt64LE(BigInt(k),p);b.writeBigUInt64LE(BigInt(v),p+8);}
 b.writeBigUInt64LE(0x600n,0x780);b.writeBigUInt64LE(1027n,0x788);b.writeBigInt64LE(0x650n,0x790);b.writeUInt32LE(60,0x650);assert.deepEqual(I.extractHelloConstants(b).keyVersion,[60]);
});
