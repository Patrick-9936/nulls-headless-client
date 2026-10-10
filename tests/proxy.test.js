const test=require('node:test'),assert=require('node:assert/strict'),net=require('net');
const {connectSocket}=require('../utils/ProxyConnect');
async function fixture(t,handler){const peers=new Set();const server=net.createServer(s=>{peers.add(s);s.on('error',()=>{});s.once('close',()=>peers.delete(s));handler(s);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{for(const s of peers)s.destroy();server.close();});return server.address().port;
}
function connect(t,port,type='socks5',extra={}){const socket=new net.Socket();t.after(()=>socket.destroy());return new Promise((resolve,reject)=>{socket.once('error',reject);connectSocket(socket,{host:'game.example',port:9339,proxy:{type,host:'127.0.0.1',port,username:'',password:'',...extra}},()=>resolve(socket));});}
function receive(socket){return new Promise((resolve,reject)=>{socket.once('data',resolve);socket.once('error',reject);});}
test('HTTP CONNECT authenticates and preserves coalesced game bytes',async t=>{
 const port=await fixture(t,s=>s.once('data',b=>{const text=b.toString();assert.match(text,/CONNECT game\.example:9339 HTTP\/1\.1/);assert.match(text,/Proxy-Authorization: Basic dXNlcjpwYXNz/);s.write('HTTP/1.1 200 Connection established\r\n\r\nGAME');}));
 const socket=await connect(t,port,'http',{username:'user',password:'pass'});assert.equal((await receive(socket)).toString(),'GAME');
});
test('HTTP rejection fails without sending a game login',async t=>{
 const port=await fixture(t,s=>s.once('data',()=>s.write('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n')));
 await assert.rejects(connect(t,port,'http'),/CONNECT rejected/);
});
test('SOCKS5 uses remote DNS and handles fragmented replies',async t=>{
 const port=await fixture(t,s=>{let stage=0;s.on('data',b=>{if(stage++===0){assert.deepEqual([...b],[5,1,0]);s.write(Buffer.from([5]));setTimeout(()=>s.write(Buffer.from([0])),5);}else{assert.equal(b[3],3);assert.equal(b.subarray(5,5+b[4]).toString(),'game.example');assert.equal(b.readUInt16BE(b.length-2),9339);s.write(Buffer.concat([Buffer.from([5,0,0,1,127,0,0,1,0,1]),Buffer.from('GAME')]));}});});
 const socket=await connect(t,port);assert.equal((await receive(socket)).toString(),'GAME');
});
test('SOCKS5 username/password negotiation is verified',async t=>{
 const port=await fixture(t,s=>{let stage=0;s.on('data',b=>{if(stage===0){assert.deepEqual([...b],[5,1,2]);s.write(Buffer.from([5,2]));}else if(stage===1){assert.deepEqual(b,Buffer.from([1,1,117,1,112]));s.write(Buffer.from([1,0]));}else s.write(Buffer.from([5,0,0,3,1,120,0,0]));stage++;});});
 await connect(t,port,'socks5',{username:'u',password:'p'});
});
test('SOCKS5 refused target fails instead of connecting directly',async t=>{
 const port=await fixture(t,s=>{let stage=0;s.on('data',()=>s.write(Buffer.from(stage++===0?[5,0]:[5,5,0,1])));});
 await assert.rejects(connect(t,port),/CONNECT rejected: 5/);
});
