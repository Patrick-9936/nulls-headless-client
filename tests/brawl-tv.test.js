const test = require('node:test'), assert = require('node:assert/strict');
const TV = require('../lib/BrawlTV'), P = require('../lib/Protocol'), A = require('../lib/Actions');
const ByteStream = require('../DataStream/ByteStream'), {parse} = require('../lib/Args');
function list() {const s=new ByteStream();s.writeVInt(1);s.writeVInt(2);s.writeRequiredString('Live');s.writeRequiredString('Test channel');return s.getBytes();}
function next(channel=2,live=true,id={hi:0,lo:123}) {const s=new ByteStream();s.writeVInt(channel);s.writeVInt(7);s.writeBoolean(live);if(live)s.writeLong(id.hi,id.lo);else s.writeRequiredString('https://example.invalid/test');return s.getBytes();}
test('native TV flag preserves ordinary spectating and its legacy alias, with version 9',()=>{
 const tag={hi:0,lo:123};
 assert.equal(P.encode('spectate',{tag}).payload.toString('hex'),'000000000000007b00');
 for(const command of [P.encode('brawl-tv',{tag}),P.encode('spectate',{tag,brawlTv:true}),P.encode('spectate',{tag,afterDeath:true})]) {
   assert.equal(command.id,14104);assert.equal(command.version,9);assert.equal(command.payload.toString('hex'),'000000000000007b01');
 }
 assert.equal(P.encode('spectate',{tag,brawlTv:false,afterDeath:true}).payload.at(-1),0);
 assert.deepEqual(parse(['spectate','--brawl-tv']).options,{brawlTv:true});
 assert.equal(P.encode('brawl-tv-channels').payload.toString('hex'),'7f01');
 assert.equal(P.encode('brawl-tv-channels').version,33);
 assert.equal(P.encode('brawl-tv-next',{channel:2}).payload.toString('hex'),'027f');
 assert.equal(P.encode('brawl-tv-next',{channel:2}).version,33);
 assert.throws(()=>P.encode('brawl-tv-next',{channel:-1}),/channel/);
});
test('TV responses decode channel strings, live IDs, unavailable sentinels and external streams strictly',()=>{
 assert.deepEqual(TV.channels(list()),[{id:2,title:'Live',description:'Test channel'}]);
 assert.equal(TV.nextUp(next()).available,true);assert.equal(TV.nextUp(next()).player.lo,123);
 assert.equal(TV.nextUp(next(2,true,{hi:0,lo:0})).available,false);
 assert.equal(TV.nextUp(next(2,true,{hi:0xffffffff,lo:0xffffffff})).available,false);
 assert.equal(TV.nextUp(next(2,false)).stream,'https://example.invalid/test');
 for(const bytes of [list().subarray(0,2),Buffer.concat([list(),Buffer.from([0])]),Buffer.alloc(65537)])assert.throws(()=>TV.channels(bytes));
 for(const bytes of [next().subarray(0,4),Buffer.concat([next(),Buffer.from([0])])])assert.throws(()=>TV.nextUp(bytes));
});
test('TV selects a server channel then its player; mismatched replies and empty loading never confirm',async()=>{
 const sent=[];const client={async request(command,args,options){sent.push({command,args});
   let type,payload;
   if(command==='brawl-tv-channels'){type=24700;payload=list();}
   else if(command==='brawl-tv-next'){assert.equal(options.check({type:24701,payload:next(3)}),false);type=24701;payload=next();}
   else {assert.equal(args.tag.lo,123);assert.deepEqual(options.types,[20559,24112]);assert.equal(options.check({payload:Buffer.alloc(0)}),false);type=24112;payload=Buffer.from([1]);}
   assert.equal(options.check({type,payload}),true);return {command,confirmed:true,response:type};}};
 const result=await TV.start(client);assert.equal(result.stage,'loading');assert.equal(result.mode,'brawl-tv');
 assert.deepEqual(sent.map(s=>s.command),['brawl-tv-channels','brawl-tv-next','brawl-tv']);
});
test('tagged TV sends a single request, while empty or external channels never masquerade as a loaded battle',async()=>{
 let count=0;
 const direct={async request(command,args){count++;assert.equal(command,'brawl-tv');return {confirmed:true,response:20559};}};
 await TV.start(direct,{tag:{hi:0,lo:123}});assert.equal(count,1);
 const empty={async request(command,args,options){options.check({payload:Buffer.from([0])});return {confirmed:true};}};
 await assert.rejects(()=>TV.start(empty),/доступных каналов/);
 const external={async request(command,args,options){assert.equal(command,'brawl-tv-next');options.check({payload:next(2,false)});return {confirmed:true};}};
 const result=await TV.start(external,{channel:2});assert.equal(result.confirmed,false);assert.equal(result.stage,'external-stream');
 await assert.rejects(()=>A.execute({},'brawl-tv'),/experimental/);
});
test('TV decoding runs in the packet handler and leaves connection establishment intact',async()=>{
 const Client=require('../lib/Client'),Proxy=require('../utils/ProxyConnect'),EventEmitter=require('node:events');
 const client=Object.create(Client.prototype);EventEmitter.call(client);Object.assign(client,{config:{packetIds:{}},pending:new Set()});
 client.on('warning',error=>assert.fail(error.message));
 client._packet(24700,list());assert.equal(client.tvChannels[0].id,2);
 client._packet(24701,next());assert.equal(client.tvNext.player.lo,123);
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'tv-connect-'));let live;
 const original=Proxy.connectSocket;let invoked=false;
 try {
   fs.copyFileSync(path.join(__dirname,'../config.json'),path.join(root,'config.json'));
   fs.copyFileSync(path.join(__dirname,'../client-license.bin'),path.join(root,'client-license.bin'));
   Proxy.connectSocket=()=>{invoked=true;};
   live=new Client({root,connectTimeout:1000});const opened=live.connect();opened.catch(()=>{});
   assert.equal(invoked,true);assert.equal(live.state,'connecting');live.close();await assert.rejects(opened,/остановлен/);
 }finally{live?.close();Proxy.connectSocket=original;fs.rmSync(root,{recursive:true,force:true});}
});
