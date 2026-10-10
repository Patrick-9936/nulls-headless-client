const S=require('../DataStream/ByteStream'),net=require('node:net');
function readArray(s,maximum){const n=s.readInt();if(n===-1)return null;if(n<0||n>maximum||n>s.remaining())throw Error('Invalid battle byte-array length');const b=Buffer.from(s.payload.subarray(s.offset,s.offset+n));s.offset+=n;return b;}
function connection(payload){
 if(!Buffer.isBuffer(payload)||payload.length>4096)throw Error('Invalid battle connection payload');
 const s=new S();s.set(payload);const port=s.readVInt(),host=s.readString(),session=readArray(s,10),key=readArray(s,128);
 if(port<1||port>65535||net.isIP(host)!==4||session?.length!==10||s.remaining())throw Error('Invalid battle connection fields');
 if(key?.length)throw Error('Encrypted UDP battle transport is not supported');
 return {host,port,session};
}
function input(tick,ack=-1,sequence=1){
 if(!Number.isInteger(tick)||tick<0||tick>16383||!Number.isInteger(ack)||ack< -1||ack>16382||!Number.isInteger(sequence)||sequence<0||sequence>8000)throw Error('Invalid battle input counters');
 const body=Buffer.alloc(12),values=[tick,ack+1,0,sequence,0,0,0,0,0],widths=[14,14,10,13,10,10,10,10,5];let bit=0;
 for(let i=0;i<values.length;i++)for(let b=0;b<widths[i];b++,bit++)if(values[i]&(1<<b))body[bit>>3]|=1<<(bit&7);
 return body;
}
function frame(session,type,payload){const s=new S();s.writeVInt(type);s.writeVInt(payload.length);return Buffer.concat([session,s.getBytes(),payload]);}
function packet(session,bytes){
 if(!Buffer.isBuffer(bytes)||bytes.length<=10||bytes.length>1400||!bytes.subarray(0,10).equals(session))throw Error('Invalid UDP battle session');
 const s=new S();s.set(bytes.subarray(10));const type=s.readVInt(),n=s.readVInt();
 if(n<0||n!==s.remaining())throw Error('Invalid UDP battle frame length');
 return {type,payload:Buffer.from(s.payload.subarray(s.offset))};
}
function vision(payload){
 const s=new S();s.set(payload);const fields=Array.from({length:6},()=>s.readVInt());
 s.readBoolean();const flag=s.readBoolean();if(flag)s.readVInt();if(s.readBoolean()){s.readVInt();s.readVInt();}
 const data=readArray(s,1400);if(!data||s.remaining()||fields[0]<0||fields[0]>16382||fields[1]< -1||fields[1]>16383)throw Error('Invalid vision update');
 return {tick:fields[0],inputAck:fields[1],bytes:data.length};
}
function socksFrame(host,port,payload){const h=Buffer.alloc(10);h[3]=1;Buffer.from(host.split('.').map(Number)).copy(h,4);h.writeUInt16BE(port,8);return Buffer.concat([h,payload]);}
function socksPacket(host,port,bytes){
 if(bytes.length<10||bytes[0]||bytes[1]||bytes[2]||bytes[3]!==1||[...bytes.subarray(4,8)].join('.')!==host||bytes.readUInt16BE(8)!==port)throw Error('Invalid SOCKS5 UDP datagram');
 return bytes.subarray(10);
}
module.exports={connection,input,frame,packet,vision,socksFrame,socksPacket};
