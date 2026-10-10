const test=require('node:test'),assert=require('node:assert/strict'),dgram=require('node:dgram'),net=require('node:net');
const P=require('../lib/BattleProtocol'),Session=require('../lib/BattleSession'),S=require('../DataStream/ByteStream');
const nonce=Buffer.from('00010203040506070809','hex');
function vision(tick=15,ack=3){const s=new S();[tick,ack,0,0,0,0].forEach(n=>s.writeVInt(n));[false,false,false].forEach(b=>s.writeBoolean(b));s.writeInt(1);return Buffer.concat([s.getBytes(),Buffer.from([0])]);}
test('native input bit widths and frame counters preserve the recovered little-endian layout',()=>{
 assert.equal(P.input(1).toString('hex'),'010000004000000000000000');
 assert.equal(P.input(0,-1,0).length,12);
 assert.throws(()=>P.input(16384),/counters/);assert.throws(()=>P.input(0,16383),/counters/);
 const body=P.input(10,5,7);assert.deepEqual(P.packet(nonce,P.frame(nonce,10555,body)),{type:10555,payload:body});
 assert.throws(()=>P.packet(Buffer.alloc(10),P.frame(nonce,10555,body)),/session/);
 assert.throws(()=>P.packet(nonce,P.frame(nonce,10555,body).subarray(0,22)),/length/);
 assert.deepEqual(P.vision(vision()),{tick:15,inputAck:3,bytes:1});
 assert.throws(()=>P.vision(vision().subarray(0,8)));
});
test('battle connection rejects truncated fields, invalid ports and unsupported encryption',()=>{
 const encoded=(port=27751,key=null)=>{const s=new S();s.writeVInt(port);s.writeRequiredString('192.0.2.1');s.writeInt(10);const tail=new S();tail.writeInt(key?key.length:-1);return Buffer.concat([s.getBytes(),nonce,tail.getBytes(),key||Buffer.alloc(0)]);};
 assert.deepEqual(P.connection(encoded()),{host:'192.0.2.1',port:27751,session:nonce});
 assert.throws(()=>P.connection(encoded(0)),/fields/);assert.throws(()=>P.connection(encoded(27751,Buffer.alloc(16))),/Encrypted/);
 assert.throws(()=>P.connection(encoded().subarray(0,20)));
});
test('SOCKS5 UDP framing rejects fragmented and unrelated datagrams',()=>{
 const b=P.socksFrame('192.0.2.1',27751,Buffer.from([1,2,3]));assert.deepEqual(P.socksPacket('192.0.2.1',27751,b),Buffer.from([1,2,3]));
 assert.throws(()=>P.socksPacket('192.0.2.2',27751,b));b[2]=1;assert.throws(()=>P.socksPacket('192.0.2.1',27751,b));
});
test('a live UDP socket confirms only a valid vision packet and closes its send timer',async()=>{
 const server=dgram.createSocket('udp4');await new Promise(r=>server.bind(0,'127.0.0.1',r));
 const session=new Session({host:'127.0.0.1',port:server.address().port,session:nonce});let inputs=0;
 server.on('message',(b,peer)=>{const p=P.packet(nonce,b);assert.equal(p.type,10555);assert.equal(p.payload.length,12);inputs++;server.send(P.frame(Buffer.alloc(10),24109,vision()),peer.port,peer.address);server.send(P.frame(nonce,24109,vision()),peer.port,peer.address);});
 try{const v=new Promise((resolve,reject)=>{session.once('vision',resolve);session.once('warning',reject);});await session.start();assert.equal((await v).tick,15);assert.equal(session.state,'active');assert.ok(session.invalid>=1);assert.ok(inputs>=1);session.close();assert.equal(session.timer._destroyed,true);assert.equal(session.timeout._destroyed,true);}
 finally{session.close();await new Promise(r=>server.close(r));}
});
test('SOCKS5 UDP keeps its control channel open and stops when that channel closes',async()=>{
 const relay=dgram.createSocket('udp4');await new Promise(r=>relay.bind(0,'127.0.0.1',r));let control,associated=false;
 const proxy=net.createServer(socket=>{control=socket;let state=0;socket.on('data',b=>{if(!state){assert.deepEqual(b,Buffer.from([5,1,0]));socket.write(Buffer.from([5,0]));state=1;}else{assert.deepEqual(b,Buffer.from([5,3,0,1,0,0,0,0,0,0]));const reply=Buffer.from([5,0,0,1,127,0,0,1,0,0]);reply.writeUInt16BE(relay.address().port,8);associated=true;socket.write(reply);}});});
 await new Promise(r=>proxy.listen(0,'127.0.0.1',r));
 const session=new Session({host:'192.0.2.1',port:27751,session:nonce},{proxy:{type:'socks5',host:'127.0.0.1',port:proxy.address().port,username:'',password:''}});
 relay.on('message',(b,peer)=>{const p=P.packet(nonce,P.socksPacket('192.0.2.1',27751,b));assert.equal(p.type,10555);relay.send(P.socksFrame('192.0.2.1',27751,P.frame(nonce,24109,vision())),peer.port,peer.address);});
 try{const v=new Promise((resolve,reject)=>{session.once('vision',resolve);session.once('warning',reject);});await session.start();await v;assert.equal(associated,true);assert.equal(control.destroyed,false);const closed=new Promise(r=>session.once('warning',r));control.destroy();assert.match((await closed).message,/association closed/);assert.equal(session.state,'failed');assert.equal(session.timer._destroyed,true);}
 finally{session.close();control?.destroy();await new Promise(r=>relay.close(r));await new Promise(r=>proxy.close(r));}
});
