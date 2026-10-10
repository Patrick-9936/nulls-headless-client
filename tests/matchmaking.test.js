const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const EventEmitter = require('node:events');
const Decode = require('../lib/Decode'), Gate = require('../lib/MatchmakingGate');
const Runner = require('../lib/CandidateRunner'), Actions = require('../lib/Actions');
const ByteStream = require('../DataStream/ByteStream');
const packet = (found = 1, required = 6) => {const s = new ByteStream(); [0,found,required,0,0].forEach(v => s.writeInt(v)); s.writeBoolean(false); return s.getBytes();};

test('20405 native capture yields 1/6 and rejects truncated, extended or impossible counters', () => {
  const captured = Buffer.from('000000000000000100000006000000000000000000','hex');
  assert.deepEqual(Decode.matchmaking(captured), {found:1, required:6, progress:'1/6', fields:[0,1,6,0,0], flag:false});
  assert.equal(Decode.matchmaking(packet(6)).progress, '6/6');
  assert.equal(Decode.matchmaking(packet(9,10)).progress, '9/10');
  assert.equal(Decode.matchmaking(packet(0,0)).progress, null);
  for (const bytes of [captured.subarray(1), Buffer.concat([captured,Buffer.from([0])]), packet(-1),packet(7),packet(1,-1)]) assert.throws(()=>Decode.matchmaking(bytes));
  const invalidFlag = Buffer.from(captured); invalidFlag[20] = 2; assert.throws(()=>Decode.matchmaking(invalidFlag));
});

test('matchmaking gate preserves FIFO, tracks restored queues and validates limits', () => {
  const gate = new Gate(), a={},b={},c={};
  assert.equal(gate.acquire(a),true); assert.equal(gate.acquire(b),false); assert.equal(gate.acquire(c),false);
  assert.equal(gate.acquire(b),false); assert.equal(gate.waiting.length,2);
  gate.release(a); assert.equal(gate.acquire(c),false); assert.equal(gate.acquire(b),true);
  gate.occupy(a); gate.release(b); assert.equal(gate.acquire(c),false);
  gate.release(a); assert.equal(gate.acquire(c),true);
  for (const limit of [0,-1,501,NaN,1.5]) assert.throws(()=>new Gate(limit));
});

test('six concurrent bots send one Ready, keep the slot after disconnect, release after confirmed load/cancel', async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'matchmaking-')), original=Actions.execute, requests=[];
  const home = new ByteStream(); [120248817,12,0,-1,60,0,0].forEach(v=>home.writeVInt(v));
  class FakeClient extends EventEmitter {
    constructor(options) {super(); this.index=options.index;this.account={hi:0,lo:this.index};this.state='online';this.generation=1;this.team={type:0,members:[]};this.home=Buffer.concat([home.getBytes(),Buffer.alloc(20)]);}
    async connect() {}
    async reconnect() {}
    close() {this.state='stopped';}
    reply(type, payload=Buffer.from([1])) {this.emit('packet',{type,payload});}
  }
  const runner=new Runner(root,{initial:6,max:6},FakeClient); runner.snapshot=()=>{};
  Actions.execute=async(client,command)=>{await new Promise(resolve=>setImmediate(resolve));if(command==='matchmake'){requests.push(client.index);client.reply(20405,packet());}return {confirmed:true,response:command==='matchmake'?20405:24124};};
  try {
    for (let i=1;i<=6;i++) runner.launch(i);
    await Promise.all(runner.bots.map(bot=>runner.play(bot)));
    assert.deepEqual(requests,[1]); assert.equal(runner.matchmakingGate.waiting.length,5);
    const first=runner.bots[0]; first.client.emit('disconnected');
    await runner.play(runner.bots[1]); assert.deepEqual(requests,[1]);
    first.client.generation=2; first.client.emit('state',{state:'setting-profile'});
    first.client.reply(24112,Buffer.alloc(0)); assert.equal(runner.matchmakingGate.active.size,1);
    first.client.reply(24112); assert.equal(runner.matchmakingGate.active.size,0);
    await Promise.all(runner.bots.slice(1).map(bot=>runner.play(bot))); assert.deepEqual(requests,[1,2]);
    runner.bots[1].client.reply(20406,Buffer.alloc(0)); assert.equal(runner.bots[1].cycle.phase,'idle');
    await runner.play(runner.bots[2]); assert.deepEqual(requests,[1,2,3]);
    // An old cancellation cannot free a different bot's reservation.
    first.client.reply(20406,Buffer.alloc(0)); assert.equal(runner.matchmakingGate.active.has(runner.bots[2]),true);
  } finally {Actions.execute=original;runner.stop();fs.rmSync(root,{recursive:true,force:true});}
});

test('a preparation failure releases the slot; an uncertain Ready timeout keeps it', async () => {
  const original=Actions.execute, root=fs.mkdtempSync(path.join(os.tmpdir(),'queue-timeout-'));
  const {Cycle}=require('../lib/CandidateLoop'); const runner=new Runner(root,{initial:1});runner.snapshot=()=>{};
  const s=new ByteStream();[120248817,12,0,-1,60,0,0].forEach(v=>s.writeVInt(v));
  const client={state:'online',team:{type:0},home:Buffer.concat([s.getBytes(),Buffer.alloc(20)]),generation:1};
  const bot={client,cycle:new Cycle(),busy:false};
  try {
    Actions.execute=async()=>{throw Error('Preparation failed');};await runner.play(bot);assert.equal(runner.matchmakingGate.active.size,0);
    Actions.execute=async(_,command)=>{if(command==='matchmake')throw Error('Unknown outcome');return {};};
    await runner.play(bot);assert.equal(runner.matchmakingGate.active.has(bot),true);
  } finally {Actions.execute=original;fs.rmSync(root,{recursive:true,force:true});}
});
