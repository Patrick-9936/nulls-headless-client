const net = require('net');
const zlib = require('zlib');
const ByteStream = require('../DataStream/ByteStream');

function makeFrame(type, payload, version=0){
  const body=Buffer.from(payload), h=Buffer.alloc(7);
  h.writeUInt16BE(type,0); h.writeUIntBE(body.length,2,3); h.writeUInt16BE(version,5);
  return Buffer.concat([h,body]);
}

function readFrame(socket, timeoutMs=8000){
  return new Promise((resolve,reject)=>{
    let acc=Buffer.alloc(0), timer=setTimeout(()=>done(reject,new Error('timeout')),timeoutMs);
    function cleanup(){ clearTimeout(timer); socket.off('data',onData); socket.off('error',onError); socket.off('close',onClose); }
    function done(fn,v){ cleanup(); fn(v); }
    function onError(e){ done(reject,e); }
    function onClose(){ done(reject,new Error('socket closed')); }
    function onData(d){
      acc=Buffer.concat([acc,d]);
      if(acc.length<7) return;
      const id=acc.readUInt16BE(0), len=acc.readUIntBE(2,3), version=acc.readUInt16BE(5);
      if(acc.length<7+len) return;
      done(resolve,{id,len,version,payload:acc.subarray(7,7+len)});
    }
    socket.on('data',onData); socket.once('error',onError); socket.once('close',onClose);
  });
}

class Cursor{
  constructor(b){this.b=Buffer.from(b);this.o=0;}
  rem(){return this.b.length-this.o;}
  u32(){if(this.rem()<4)throw new Error('EOF u32');const v=this.b.readUInt32BE(this.o);this.o+=4;return v;}
  bytes(n){if(n<0||this.rem()<n)throw new Error(`EOF bytes ${n}`);const v=this.b.subarray(this.o,this.o+n);this.o+=n;return v;}
  str(){const n=this.u32();if(n===0xffffffff)return null;if(this.rem()<n)throw new Error(`bad string len ${n}`);return this.bytes(n).toString();}
  skip(n){this.bytes(n);}
}

function parseProbePayload(payload){
  const r=new Cursor(payload), status=r.u32(), result={status};
  if(status!==7) return result;
  result.unknown0=r.u32(); result.unknown1=r.u32(); result.contentUrl=r.str(); result.unknown2=r.u32();
  let fp=r.str();
  if(fp==='' || fp===null){
    r.skip(5); const compressedLength=r.u32();
    if(r.rem()<4) throw new Error('missing decompressed length');
    const little=r.bytes(4).readUInt32LE(0), compressed=r.bytes(compressedLength), decompressed=zlib.inflateSync(compressed);
    if(little && decompressed.length!==little) result.decompressedLengthWarning={expected:little,actual:decompressed.length};
    fp=decompressed.toString('utf8');
  }
  result.fingerprintRaw=fp; try{result.fingerprint=JSON.parse(fp);}catch{}
  try{result.assetsUrl=r.str(); result.assetsUrl2=r.str();}catch{}
  return result;
}

async function probe({host='game.brawlstarsgame.com',port=9339,timeoutMs=15000,keyVersion=56,protocolVersion=2,contentHash='lilmuff1'}){
  const socket=new net.Socket();
  await new Promise((resolve,reject)=>{ const onErr=e=>{socket.off('connect',resolve);reject(e)}; socket.once('error',onErr); socket.once('connect',()=>{socket.off('error',onErr);resolve();}); socket.connect(port,host); });
  try{
    const s=new ByteStream(128);
    s.writeInt(protocolVersion); s.writeInt(keyVersion);
    s.writeInt(0); s.writeInt(0); s.writeInt(0);
    s.writeRequiredString(contentHash);
    s.writeInt(2); s.writeInt(2);
    socket.write(makeFrame(10100,s.getBytes(),0));
    const frame=await readFrame(socket,timeoutMs);
    return {frame:{id:frame.id,length:frame.len,version:frame.version},...parseProbePayload(frame.payload)};
  } finally { socket.destroy(); }
}

module.exports={probe,parseProbePayload};
