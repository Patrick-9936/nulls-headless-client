const net=require('net');
const Hello=require('../Messaging/Messages/Client/ModernClientHelloMessage');
const Login=require('../Messaging/Messages/Client/LoginMessage');
const {parseProbePayload}=require('./FingerprintProbe');
function frame(id,body,version=0){const h=Buffer.alloc(7);h.writeUInt16BE(id);h.writeUIntBE(body.length,2,3);h.writeUInt16BE(version,5);return Buffer.concat([h,body]);}
class Frames {
 constructor(socket){this.socket=socket;this.buf=Buffer.alloc(0);this.queue=[];this.pending=null;this.error=null;
  socket.on('data',b=>{this.buf=Buffer.concat([this.buf,b]);
   while(this.buf.length>=7){const n=this.buf.readUIntBE(2,3);if(n>16*1024*1024)return this.fail(new Error('Oversized server frame'));
    if(this.buf.length<n+7)return;const f={id:this.buf.readUInt16BE(0),payload:this.buf.subarray(7,n+7)};this.buf=this.buf.subarray(n+7);
    if(this.pending){const p=this.pending;this.pending=null;clearTimeout(p.timer);p.resolve(f);}else{if(this.queue.length>=64)return this.fail(new Error('Too many queued frames'));this.queue.push(f);}}
  });socket.on('error',e=>this.fail(e));socket.on('close',()=>this.fail(new Error('Server closed connection')));
 }
 fail(e){this.error=e;if(this.pending){clearTimeout(this.pending.timer);this.pending.reject(e);this.pending=null;}this.socket.destroy();}
 next(ms){if(this.queue.length)return Promise.resolve(this.queue.shift());if(this.error)return Promise.reject(this.error);
  return new Promise((resolve,reject)=>{const timer=setTimeout(()=>this.fail(new Error('Server response timed out')),ms);this.pending={resolve,reject,timer};});}
 close(){this.fail(new Error('Connection finished'));}
}
async function connect(config){const socket=new net.Socket(),frames=new Frames(socket);
 await new Promise((resolve,reject)=>{const t=setTimeout(()=>{socket.destroy();reject(new Error('Connect timed out'));},10000);
  const error=e=>{clearTimeout(t);reject(e);};socket.once('error',error);
  socket.connect(config.port,config.host,()=>{clearTimeout(t);socket.off('error',error);resolve();});});return frames;}
function hello(c){const h=new Hello(c);h.encode();return h.ByteStream.getBytes();}
async function fingerprint(config){
 const c={...config,fingerprintHash:'0'.repeat(40)},conn=await connect(c);
 try{conn.socket.write(frame(c.packetIds.clientHello,hello(c)));const f=await conn.next(15000);
  if(f.id===c.packetIds.loginFailed)return parseProbePayload(f.payload);
  if(f.id===c.packetIds.serverHello)return {status:null,helloAccepted:true};throw new Error('Unexpected fingerprint response '+f.id);
 }finally{conn.close();}
}
async function verify(config,account,root,{helloOnly=false}={}){
 if(!helloOnly && (!account || !(account.hi||account.lo) || !(account.passToken||account.token)))throw new Error('Saved account required for verification; updater never creates accounts');
 const c={...config};const conn=await connect(c);
 const crypto=c.cryptoMode==='nulls-native19'?new(require('../Crypto/NullsCrypto'))(c):new(require('../Crypto/ModernCrypto'))(c);
 try{conn.socket.write(frame(c.packetIds.clientHello,hello(c)));let f=await conn.next(15000);
  if(f.id!==c.packetIds.serverHello){const e=new Error('ClientHello rejected: '+(f.payload.length>=4?f.payload.readInt32BE(0):f.id));e.serverStatus=f.id===c.packetIds.loginFailed&&f.payload.length>=4?f.payload.readInt32BE(0):null;throw e;}
  crypto.decrypt(f.id,f.payload);if(helloOnly)return {serverHello:true};
  if(c.cryptoMode==='native19')crypto.setChallengeResponse(new(require('../Crypto/AndroidChallengeBridge'))(root).respond(crypto.sessionKey));
  const login=new Login(c,account);login.encode();conn.socket.write(frame(c.packetIds.login,crypto.encrypt(c.packetIds.login,login.ByteStream.getBytes()),c.loginHeaderVersion??10));
  let loggedIn=false;const deadline=Date.now()+20000;
  while(Date.now()<deadline){f=await conn.next(Math.max(1,deadline-Date.now()));const plain=crypto.decrypt(f.id,f.payload);if(!plain)throw new Error('Handshake decryption failed; crypto/key may have changed');
   if(f.id===c.packetIds.loginFailed)throw new Error('Login rejected: '+(plain.length>=4?plain.readInt32BE(0):'unknown'));
   if(f.id===c.packetIds.loginOk){if(plain.length<8 || plain.readUInt32BE(0)!==(account.hi>>>0) || plain.readUInt32BE(4)!==(account.lo>>>0))throw new Error('LoginOk account/layout mismatch');loggedIn=true;}
   if(f.id===c.packetIds.ownHomeData && loggedIn){if(plain.length<8)throw new Error('HomeData too short');return {serverHello:true,loginOk:true,homeData:true};}
  }throw new Error('Login/HomeData verification timed out');
 }finally{conn.close();}
}
module.exports={frame,Frames,fingerprint,verify};
