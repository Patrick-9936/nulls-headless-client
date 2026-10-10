const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {Cycle, currentEvent} = require('../lib/CandidateLoop');
const Sources = require('../lib/ProxySources'), Runner = require('../lib/CandidateRunner');
const ByteStream = require('../DataStream/ByteStream');
test('UDP marks a battle connection without counting a result or accepting an old session',()=>{
 const c=new Cycle();c.begin(1);c.packet(24112,1);c.battleConnected(2);assert.equal(c.phase,'loading');
 c.battleConnected(1);assert.equal(c.phase,'battle');assert.equal(c.completed,0);
 c.disconnect();assert.equal(c.phase,'result-unknown');c.resume(2);c.battleConnected(2);assert.equal(c.phase,'battle');
 assert.equal(c.packet(23456,1),false);assert.equal(c.packet(23456,2),true);assert.equal(c.completed,1);
});
test('login restores a running battle before ready without starting another matchmaking request',()=>{
 const c=new Cycle();assert.equal(c.packet(24112,8,38),false);assert.equal(c.phase,'loading');assert.equal(c.begin(8),false);assert.equal(c.completed,0);
 c.battleConnected(8);assert.equal(c.packet(23456,8),true);assert.equal(c.completed,1);
});
test('registration retries an unconfirmed name after token issuance and preserves confirmed names', async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'candidate-name-')),options=[];
  class FakeClient extends require('node:events').EventEmitter {
    constructor(o){super();options.push(o);this.account={};}
    async connect(){}
    close(){}
  }
  const runner=new Runner(root,{name:'nullsbsd'},FakeClient);runner.snapshot=()=>{};
  try {
    const dir=path.join(root,'.runtime/candidates/accounts');fs.mkdirSync(dir,{recursive:true});
    fs.writeFileSync(path.join(dir,'bot-2.json'),JSON.stringify({passToken:'test-token'}));
    fs.writeFileSync(path.join(dir,'bot-3.json'),JSON.stringify({passToken:'test-token',name:'Confirmed'}));
    runner.launch(1);runner.launch(2);runner.launch(3);
    assert.deepEqual(options.map(o=>o.name),['nullsbsd','nullsbsd',undefined]);
    await new Promise(resolve=>setImmediate(resolve));assert.equal(runner.inflight,0);
  } finally {runner.stop();fs.rmSync(root,{recursive:true,force:true});}
});
test('battle loop needs a same-session server result; disconnect, Home and duplicate end never count', () => {
  const cycle = new Cycle(); assert.equal(cycle.begin(3), true);
  cycle.packet(20405, 3); assert.equal(cycle.phase, 'queued');
  assert.equal(cycle.packet(23456, 3), false);
  cycle.packet(24112, 3); assert.equal(cycle.phase, 'loading');
  cycle.packet(24101, 3); assert.equal(cycle.completed, 0);
  assert.equal(cycle.packet(23456, 2), false);
  assert.equal(cycle.packet(23456, 3, 0), false);
  assert.equal(cycle.packet(23456, 3), true); assert.equal(cycle.completed, 1);
  assert.equal(cycle.packet(23456, 3), false); cycle.resetAfterEnd();
  cycle.begin(4); cycle.packet(24112, 4); cycle.disconnect();
  assert.equal(cycle.phase, 'result-unknown'); assert.throws(() => cycle.resetAfterEnd(), /не подтверждён/);
  assert.equal(cycle.packet(23456, 5), false); assert.equal(cycle.begin(5), false);
});
test('candidate selection excludes future/expired entries and rejects ambiguous Home data', () => {
  const entry = (id, start, end) => {const s = new ByteStream(); [id,12,0,start,end,0,0].forEach(n => s.writeVInt(n)); return s.getBytes();};
  const home = Buffer.concat([entry(120248817,-2737,4463), entry(120248818,4463,11663), Buffer.alloc(20)]);
  assert.equal(currentEvent(home).event, 120248817);
  assert.throws(() => currentEvent(Buffer.concat([entry(120248817,-1,60),entry(120248818,-1,60),Buffer.alloc(20)])), /Неоднозначное/);
  assert.throws(() => currentEvent(Buffer.alloc(30)), /Неоднозначное/);
});
test('proxy lists normalize both formats, reject local networks and fairly cap candidates', () => {
  assert.equal(Sources.normalize('8.8.8.8:1080'), 'socks5://8.8.8.8:1080');
  assert.equal(Sources.normalize('1.1.1.1:8080','http'), 'http://1.1.1.1:8080');
  for (const value of ['127.0.0.1:1','10.0.0.1:1','192.168.1.1:1','172.16.0.1:1','169.254.1.1:1','100.64.0.1:1','256.1.1.1:1','evil.test:1','http://8.8.8.8:80/path','http://u:p@8.8.8.8:80']) assert.equal(Sources.normalize(value), null);
  const groups = [['socks5://8.8.8.8:1','socks5://8.8.8.8:2'],['http://1.1.1.1:3','http://1.1.1.1:4']];
  assert.deepEqual(Sources.select(groups,[],2),[groups[0][0],groups[1][0]]);
  assert.deepEqual(Sources.select(groups,[],2,1),[groups[0][1],groups[1][1]]);
  assert.equal(Sources.select(groups,[groups[0][0],groups[0][0]],3).length,3);
});
test('proxy download stops at its byte budget and cancels a growing response', async () => {
  const original = global.fetch; let cancelled = false;
  global.fetch = async () => ({ok:true,body:new ReadableStream({pull(controller) {controller.enqueue(Buffer.from('8.8.8.8:80\n'.repeat(100)));},cancel(){cancelled=true;}})});
  try {const result = await Sources.download({url:'unused'},undefined,100); assert.equal(result.bytes,100); assert.equal(result.truncated,true); assert.equal(cancelled,true); assert.ok(result.text.length<=100);}
  finally {global.fetch=original;}
});
test('resource cap stops growth before creating a connection; unsafe fleet bounds are rejected', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'candidate-rss-'));
  try {const runner=new Runner(root,{initial:1,max:2}); runner.rssLimit=1; runner.tick(); assert.equal(runner.stopping,true); assert.equal(runner.bots.length,0);
    assert.throws(()=>new Runner(root,{max:-1}),/лимиты/); assert.throws(()=>new Runner(root,{concurrency:9}),/лимиты/); assert.throws(()=>new Runner(root,{growSeconds:0}),/лимиты/);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('restored lobby missing from Home is recovered only after server membership error 10', async () => {
 const Actions=require('../lib/Actions'),original=Actions.execute,calls=[];
 const s=new ByteStream();[120248817,12,0,-1,60,0,0].forEach(n=>s.writeVInt(n));
 const client={state:'online',home:Buffer.concat([s.getBytes(),Buffer.alloc(20)]),generation:1,team:null};
 const bot={client,cycle:new Cycle(),busy:false};const runner=new Runner('.', {initial:1});runner.snapshot=()=>{};
 let failed=false;
 Actions.execute=async(c,command)=>{calls.push(command);if(command==='create-room'&&!failed){failed=true;throw Error('Сервер отклонил действие: команда 10: already in a team');}if(command==='matchmake')bot.cycle.packet(20405,1);return {confirmed:true,response:command==='matchmake'?20405:24124};};
 try {await runner.play(bot);assert.deepEqual(calls,['create-room','leave-room','create-room','team-event','matchmake']);assert.equal(bot.cycle.phase,'queued');assert.equal(bot.error,null);}
 finally {Actions.execute=original;}
});

test('authenticated reconnect resumes an uncertain battle without treating Home as a result', () => {
 const c=new Cycle();c.begin(1);c.packet(24112,1);c.disconnect();c.resume(2);
 assert.equal(c.phase,'awaiting-resume');assert.equal(c.packet(24101,2),false);assert.equal(c.completed,0);
 assert.equal(c.packet(23456,1),false);assert.equal(c.packet(23456,2),true);assert.equal(c.completed,1);assert.equal(c.packet(23456,2),false);
});
