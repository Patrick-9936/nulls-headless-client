const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs');
const ByteStream=require('../DataStream/ByteStream'),readAge=require('../utils/HomeAge');
test('registration validates the exact name and waits for application confirmation',()=>{
 const Messaging=require('../Messaging/Messaging'),Queue=require('../DataStream/Queue');
 const old=global.Debugger;global.Debugger={info(){},error(){}};
 function receive(m,type,body){const p=body.getBytes(),h=Buffer.alloc(7);h.writeUInt16BE(type);h.writeUIntBE(p.length,2,3);m._queue.add(Buffer.concat([h,p]));m.update();}
 try {for(const [code,returned,accept] of [[0,'@mynbscript',true],[1,'@mynbscript',false],[0,'Modified',false]]) {
  const m=new Messaging({destroyed:false,end(){},destroy(){}},new Queue(),{config:require('../config.json'),account:{},action:{mode:'login',name:'@mynbscript'}});
  const sent=[],errors=[];m.crypto={decrypt:(_,p)=>p};m.saveAccount=()=>{};m.send=(id,p,version)=>sent.push({id,version});m.onProfileError=e=>errors.push(e.message);
  m.onHomeReady(Buffer.alloc(0));assert.deepEqual(sent,[{id:14600,version:9}]);assert.equal(m.namePending,true);
  const response=new ByteStream();response.writeBoolean(code!==0);response.writeInt(code);response.writeRequiredString(returned);receive(m,20300,response);
  assert.equal(m.account.name,undefined);
  if(accept){assert.deepEqual(sent.map(p=>p.id),[14600,10212]);assert.equal(m.namePending,true);const rejected=new ByteStream();rejected.writeInt(0);receive(m,20205,rejected);assert.match(errors[0],/установку ника/);}
  else {assert.equal(sent.length,1);assert.equal(errors.length,1);assert.match(errors[0],/код проверки/);}
 }} finally {global.Debugger=old;}
});
test('native signed VInt fixtures decode without corrupting negative values',()=>{
  for(const [hex,n] of [['7f',-1],['40',-64],['ff7e',-65],['8903',201],['ff',null]]) {
    const s=new ByteStream();s.set(Buffer.from(hex,'hex'));
    if(n===null)assert.throws(()=>s.readVInt(),/EOF/);else assert.equal(s.readVInt(),n);
  }
});
test('age command advances EndClientTurn past command execution tick',()=>{
 const Age=require('../Messaging/Messages/Client/SetAgeMessage'),m=new Age(21);m.encode();
 assert.equal(m.ByteStream.getBytes().toString('hex'),'00010192080000000000000015ffffffff');
 assert.throws(()=>new Age(18).encode(),/19/);
});
test('server age fixtures distinguish pending registration from accepted adult state',()=>{
 const pending=fs.readFileSync(__dirname+'/fixtures/home-age-pending.bin');
 const adult=fs.readFileSync(__dirname+'/fixtures/home-age-adult.bin');
 assert.equal(readAge(pending).state,1);assert.equal(readAge(adult).state,2);
 assert.equal(readAge(adult.subarray(0,adult.length-1)),null);
 assert.equal(readAge(Buffer.concat([pending,adult])),null);
});
test('server nickname command preserves the login token and reconnects',()=>{
 const Messaging=require('../Messaging/Messaging'),Queue=require('../DataStream/Queue');
 const q=new Queue(),body=new ByteStream();body.writeVInt(201);body.writeRequiredString('ChosenBot');body.writeVInt(0);body.writeRequiredString('session-jwt');
 const payload=body.getBytes(),header=Buffer.alloc(7);header.writeUInt16BE(24111);header.writeUIntBE(payload.length,2,3);q.add(Buffer.concat([header,payload]));
 const old=global.Debugger;global.Debugger={info(){},error(msg){assert.fail(msg)}};
 let saved=0,reconnected=0;
 const account={passToken:'original-login-token',token:'original-login-token'};
 const m=new Messaging({end(){},destroy(){}},q,{config:require('../config.json'),account,action:{mode:'rename',name:'ChosenBot'},reconnect(){reconnected++;}});
 m.crypto={decrypt:(_,b)=>b};m.saveAccount=()=>saved++;
 try{m.update();assert.equal(account.passToken,'original-login-token');assert.equal(account.name,'ChosenBot');assert.equal(account.nameChangeToken,'session-jwt');assert.equal(reconnected,1);assert.equal(saved,1);}finally{global.Debugger=old;}
});
test('player tag accepts the common letter O typo and uses native friend fields',()=>{
 const Tag=require('../utils/TagCodec'),Friend=require('../Messaging/Messages/Client/AddFriendMessage');
 const a=Tag.tagToLogicLong('#2VPUQJPQOL');assert.equal(a.tag,'#2VPUQJPQ0L');
 const m=new Friend(a);m.encode();assert.equal(m.ByteStream.getBytes().toString('hex'),'000000020965ca7b0000000000000000');
});
test('native room requests use the recovered create and free-text message IDs',()=>{
 const Messaging=require('../Messaging/Messaging');
 const old=global.Debugger;global.Debugger={info(){},error(msg){assert.fail(msg)}};
 try {
  for(const [action,id,hex] of [
   [{mode:'create-room'},12541,'0000000000000000007f7f'],
   [{mode:'chat',text:'endy test'},14049,'00000009656e64792074657374'],
   [{mode:'leave-room'},14353,'']
  ]) {
   const m=new Messaging({destroyed:false},null,{config:require('../config.json'),account:{},action});
   const sent=[];m.send=(type,payload,version)=>sent.push([type,payload.toString('hex'),version]);m.runAction('home-data');
   assert.deepEqual(sent,[[id,hex,0]]);
  }
 } finally { global.Debugger=old; }
});
test('server echo confirms chat; unsolicited room-leave packets do not confirm an action',()=>{
 const Messaging=require('../Messaging/Messaging'),Queue=require('../DataStream/Queue');
 const old=global.Debugger;global.Debugger={info(){},error(msg){assert.fail(msg)}};
 function received(id,fixture,action,sent=true) {
  const q=new Queue(),payload=fs.readFileSync(__dirname+'/fixtures/'+fixture),header=Buffer.alloc(7);header.writeUInt16BE(id);header.writeUIntBE(payload.length,2,3);q.add(Buffer.concat([header,payload]));
  const m=new Messaging({end(){},destroy(){}},q,{config:require('../config.json'),account:{},action});m.actionSent=sent;m.crypto={decrypt:(_,b)=>b};m.saveAccount=()=>{};m.update();return m;
 }
 try {
  assert.equal(received(24131,'team-chat-confirmed.bin',{mode:'chat',text:'endy test'}).chatConfirmed,true);
  assert.equal(received(24125,'team-left-confirmed.bin',{mode:'leave-room'}).leaveConfirmed,true);
  assert.equal(received(24125,'team-left-confirmed.bin',{mode:'leave-room'},false).leaveConfirmed,undefined);
 } finally {global.Debugger=old;}
});
