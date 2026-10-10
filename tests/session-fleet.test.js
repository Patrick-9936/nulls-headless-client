const test=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'), path=require('node:path'), os=require('node:os');
const {EventEmitter}=require('node:events');
const Fleet=require('../lib/Fleet'),Store=require('../lib/Store'),Lock=require('../lib/AccountLock'),Client=require('../lib/Client'),A=require('../lib/Actions'),D=require('../lib/Decode'),P=require('../lib/Protocol'),S=require('../DataStream/ByteStream');
const fixture=name=>fs.readFileSync(path.join(__dirname,'fixtures',name));
const flush=()=>new Promise(resolve=>setImmediate(resolve));
test('one refused account leaves the fleet queue running; explicit retry restarts blocked slots',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'nulls-fleet-'));let allow=false;
 class Fake extends EventEmitter {
  constructor(o){super();this.options=o;this.index=o.index;this.account={hi:0,lo:100+o.index,passToken:'test',name:o.name};this.attempts=1;}
  async connect(){this.state='connecting';this.emit('state',{state:this.state});await flush();if(this.index===1&&!allow){this.permanentError='test server refusal';throw new Error(this.permanentError);}this.state='online';this.emit('account',this.account);this.emit('state',{state:this.state});this.emit('online');return this;}
  close(){this.state='stopped';this.emit('state',{state:this.state});}
 }
 const fleet=new Fleet(root,{count:3,concurrency:1},Fake);
 try{fleet.start();for(let i=0;i<8;i++)await flush();assert.deepEqual(fleet.slots.map(s=>s.status),['blocked','online','online']);assert.equal(fleet.paused,false);assert.equal(fleet.inflight,0);
 allow=true;Store.write(path.join(fleet.commandDir,'aabbcc.json'),{action:'retry'});await fleet.processCommands();for(let i=0;i<4;i++)await flush();assert.deepEqual(fleet.slots.map(s=>s.status),['online','online','online']);}
 finally{fleet.stop();fs.rmSync(root,{recursive:true,force:true});}
});
test('account lock prevents competing logins and recovers a dead process lock',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'nulls-lock-')), file=path.join(root,'account.json'),a=new Lock(file),b=new Lock(file);
 try{a.acquire();assert.throws(()=>b.acquire(),/уже используется/);b.release();assert.equal(fs.existsSync(file+'.lock'),true);a.release();Store.write(file+'.lock',{pid:2147483647,id:'dead'});b.acquire();assert.equal(b.owned,true);b.release();assert.equal(fs.existsSync(file+'.lock'),false);}finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('consecutive native booleans share one byte; the next field resets the bit cursor',()=>{
 const s=new S();s.writeBoolean(true);s.writeBoolean(false);s.writeBoolean(true);s.writeVInt(201);s.writeBoolean(false);s.writeBoolean(true);assert.equal(s.getBytes().toString('hex'),'05890302');
 const r=D.stream(s.getBytes());assert.equal(r.readBoolean(),true);assert.equal(r.readBoolean(),false);assert.equal(r.readBoolean(),true);assert.equal(r.readVInt(),201);assert.equal(r.readBoolean(),false);assert.equal(r.readBoolean(),true);assert.equal(r.remaining(),0);
});
test('captured server lobby decodes both flags and every member without losing -1 empty arrays',()=>{
 const room=D.team(fixture('team-state-v69.bin'));assert.equal(room.parseWarning,undefined);assert.equal(room.members.length,2);assert.equal(room.members[0].leader,true);assert.equal(room.members[1].leader,false);assert.equal(room.location.class,15);assert.equal(room.members[0].brawler.class,16);
});
test('server captures decode club membership, accepted friendship, ranking and explicit offline status',()=>{
 const club=D.club(24301,fixture('club-info-v69.bin'));assert.equal(club.complete,true);assert.ok(club.members.some(m=>m.role===2));
 const friends=D.friends(fixture('friend-list-v69.bin'));assert.equal(friends.friends[0].relationship,4);assert.equal(friends.friends[0].online,undefined);
 const top=D.leaderboard(fixture('top-v69.bin'));assert.equal(top.entries.length,200);assert.equal(top.entries[0].position,1);assert.equal(top.entries.at(-1).position,200);assert.ok(top.entries[0].score>top.entries.at(-1).score);assert.match(top.entries[0].tag,/^#/);
 assert.equal(D.friendPresence(fixture('friend-offline-v69.bin')).online,false);assert.ok(D.clubOnline(fixture('club-online-v69.bin')).onlineCount>=0);
});
test('team kick ignores an unrelated team update while the target is still present',async()=>{
 const client=Object.create(Client.prototype);EventEmitter.call(client);Object.assign(client,{state:'online',pending:new Set(),account:{hi:0,lo:99},config:{packetIds:{}},save(){}});
 const target={hi:0,lo:100};client.team={members:[target]};client.messaging={send(){client.team={members:[target]};client._packet(24124,Buffer.alloc(0));setTimeout(()=>{client.team={members:[]};client._packet(24124,Buffer.alloc(0));},20)}};
 const started=Date.now();const result=await A.execute(client,'team-kick',{tag:target,timeout:500});assert.equal(result.confirmed,true);assert.ok(Date.now()-started>=15);assert.equal(client.pending.size,0);
});
test('rejected and timed out protocol requests never claim confirmation',async()=>{
 const client=Object.create(Client.prototype);EventEmitter.call(client);Object.assign(client,{state:'online',pending:new Set(),config:{packetIds:{}}});client.messaging={send(){client._packet(24129,Buffer.from('00110000','hex'))}};
 await assert.rejects(()=>client.request('ready',{}, {types:[24124],errors:[24129],timeout:100}),/отклонил/);client.messaging.send=()=>{};await assert.rejects(()=>client.request('ready',{}, {types:[24124],timeout:10}),/Нет подтверждения/);assert.equal(client.pending.size,0);
});
test('native request cancellation and approval preserve the packed approval flags',()=>{
 assert.equal(P.encode('team-cancel-request').id,14880);assert.equal(P.encode('team-cancel-request').payload.length,0);
 const m=P.encode('team-request-answer',{tag:{hi:0,lo:100},accept:true,spectator:true});assert.equal(m.payload.toString('hex'),'000000000000006403');assert.equal(m.version,23);
 assert.throws(()=>P.encode('club-settings',{settings:{type:1,requiredTrophies:-1}}),/required-trophies/);assert.throws(()=>P.encode('chat',{text:''}),/text/);
});
test('invite response uses the lobby ID, decision 1/2, and a separate spectator flag',()=>{
 const room={hi:0,lo:1348064};
 assert.equal(P.encode('invite-answer',{team:room,accept:true}).payload.toString('hex'),'0100000000001491e000');
 assert.equal(P.encode('invite-answer',{team:room,accept:false,spectator:true}).payload.toString('hex'),'0200000000001491e001');
 assert.throws(()=>P.encode('invite-answer',{tag:{hi:0,lo:100}}),/ID команды/);
 assert.throws(()=>P.encode('team-brawler',{brawler:'16:1'}),/экипировку/);
});
test('ordinary matchmaking refuses duplicate fighters before sending ready',async()=>{
 let sent=false;const client={team:{type:0,members:[{brawler:{index:0}},{brawler:{index:0}}]},request(){sent=true;}};
 await assert.rejects(()=>A.execute(client,'matchmake'),/разных бойцов/);assert.equal(sent,false);
});
test('experimental requests require an explicit flag before network use',async()=>{
 await assert.rejects(()=>A.execute({},'team-advertise',{type:1}),/experimental/);
});
test('real server invitation state decodes sender and recipient after all team members',()=>{
 const team=D.team(fixture('team-invite-v69.bin'));assert.equal(team.parseWarning,undefined);assert.ok(team.pendingInvites.length);const inv=team.pendingInvites[0];assert.equal(inv.inviter.lo,team.members[0].lo);assert.notEqual(inv.player.lo,inv.inviter.lo);assert.equal(inv.spectator,false);assert.match(inv.player.tag,/^#/);
});
