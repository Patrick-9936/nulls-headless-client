const fs = require('fs');

const SPK_MARKER = Buffer.from([0x1A, 0xD5, 0, 0, 0, 0, 0, 0]);

function findAll(haystack, needle) {
  const out = [];
  let at = 0;
  while (at <= haystack.length - needle.length) {
    const p = haystack.indexOf(needle, at);
    if (p < 0) break;
    out.push(p);
    at = p + 1;
  }
  return out;
}

function extractSpkFromBuffer(data) {
  const positions = findAll(data, SPK_MARKER);
  if (!positions.length) throw new Error('SPK marker not found');
  const pos = positions[positions.length - 1];
  if (pos < 128) throw new Error('Not enough bytes before SPK marker');

  const block = data.subarray(pos - 128, pos);
  const u16 = Array.from({ length: 64 }, (_, i) => block.readUInt16LE(i * 2));
  const key = Buffer.alloc(32);

  for (let i = 0; i < 16; i++) {
    const v16 = u16[31 - 2 * i + 32];
    const v17 = (u16[2 * i + 1] ^ v16) | (v16 ^ u16[2 * i]);
    const shiftL = 11 - (i & 7);
    const shiftR = ((i & 7) - 11) & 0x0f;
    const rotated = ((v17 << shiftL) | (v17 >>> shiftR)) & 0xffff;
    const result = rotated ^ u16[31 - i + 32];
    key[2 * i] = result & 0xff;
    key[2 * i + 1] = (result >>> 8) & 0xff;
  }

  return { keyHex: key.toString('hex').toUpperCase(), markerOffsets: positions };
}

function findVersionStrings(data) {
  // Keep likely app/library versions only, not every arbitrary float in the binary.
  const text = data.toString('latin1');
  const set = new Set();
  for (const m of text.matchAll(/(?:^|[^0-9])(\d{2}\.\d{2,3})(?![0-9])/g)) set.add(m[1]);
  return [...set].sort((a, b) => {
    const aa = a.split('.').map(Number), bb = b.split('.').map(Number);
    return aa[0] - bb[0] || aa[1] - bb[1];
  });
}

function inspectLib(path) {
  const data = fs.readFileSync(path);
  const spk = extractSpkFromBuffer(data);
  return {
    path,
    size: data.length,
    serverPublicKeyHex: spk.keyHex,
    spkMarkerOffsets: spk.markerOffsets,
    versionStrings: findVersionStrings(data),
  };
}

module.exports = { inspectLib, extractSpkFromBuffer, findVersionStrings };

// Extract constants only from recognizable ARM64 ClientHello setter calls.
function extractHelloConstants(data) {
  if(data.subarray(0,4).toString('hex')!=='7f454c46'||data[4]!==2||data.readUInt16LE(18)!==183)return {};
  const ph=Number(data.readBigUInt64LE(32)),size=data.readUInt16LE(54),count=data.readUInt16LE(56),segments=[];let dynamic=null;
  for(let i=0;i<count;i++){const p=ph+i*size;if(p+56>data.length)throw new Error('Invalid ELF program headers');
    if(data.readUInt32LE(p)===2)dynamic={offset:Number(data.readBigUInt64LE(p+8)),size:Number(data.readBigUInt64LE(p+32))};
    if(data.readUInt32LE(p)===1)segments.push({offset:Number(data.readBigUInt64LE(p+8)),address:Number(data.readBigUInt64LE(p+16)),size:Number(data.readBigUInt64LE(p+32)),exec:!!(data.readUInt32LE(p+4)&1)});}
  function offset(v){const seg=segments.find(s=>v>=s.address&&v+8<=s.address+s.size);return seg?seg.offset+v-seg.address:null;}
  const tags=new Map(),relocations=new Map();
  if(dynamic)for(let p=dynamic.offset;p+16<=dynamic.offset+dynamic.size;p+=16){const t=Number(data.readBigUInt64LE(p)),v=Number(data.readBigUInt64LE(p+8));if(!t)break;tags.set(t,v);}
  if(tags.has(7)&&tags.get(9)===24){const start=offset(tags.get(7));if(start!==null)for(let p=start;p+24<=start+tags.get(8);p+=24){
    if(p+24>data.length)throw new Error('Invalid ELF relocations');const addr=Number(data.readBigUInt64LE(p)),info=data.readBigUInt64LE(p+8),add=Number(data.readBigInt64LE(p+16)),type=Number(info&0xffffffffn);
    if(type===1027)relocations.set(addr,add);
    else if(type===1025&&tags.has(6)){const symbol=offset(tags.get(6)+Number(info>>32n)*24);if(symbol!==null)relocations.set(addr,Number(data.readBigUInt64LE(symbol+8))+add);}
  }}
  function read(v,wide){if(wide&&relocations.has(v))return relocations.get(v);const p=offset(v);return p===null?undefined:wide?Number(data.readBigUInt64LE(p)):data.readUInt32LE(p);}
  function constantBefore(call,seg){const regs=new Map();for(let p=Math.max(seg.offset,call-64);p<call;p+=4){const w=data.readUInt32LE(p),rd=w&31,rn=(w>>>5)&31;
    if(((w&0x9f000000)>>>0)===0x90000000){let d=((w>>>29)&3)|(((w>>>5)&0x7ffff)<<2);if(d&0x100000)d-=0x200000;regs.set(rd,((seg.address+p-seg.offset)&~4095)+d*4096);}
    else if(((w&0xffc00000)>>>0)===0xf9400000||((w&0xffc00000)>>>0)===0xb9400000){const wide=!!(w&0x40000000),addr=regs.get(rn);regs.set(rd,addr===undefined?undefined:read(addr+((w>>>10)&4095)*(wide?8:4),wide));}
    else if(((w&0xffe00000)>>>0)===0x52800000)regs.set(rd,(w>>>5)&0xffff);
    else if(((w&0xfc000000)>>>0)===0x94000000){for(let r=0;r<=18;r++)regs.delete(r);}
  }return regs.get(1);}
  const signature=Buffer.alloc(40);for(let i=0;i<5;i++){signature.writeUInt32LE((0xb9000001|(((0x90+4*i)/4)<<10))>>>0,i*8);signature.writeUInt32LE(0xd65f03c0,i*8+4);}
  const candidates=[];let pos=-1;
  while((pos=data.indexOf(signature,pos+1))>=0){const seg=segments.find(s=>s.exec&&pos>=s.offset&&pos+40<=s.offset+s.size);if(seg)candidates.push(seg.address+pos-seg.offset);}
  const values={protocolVersion:new Set(),keyVersion:new Set()};
  for(const seg of segments.filter(s=>s.exec))for(let p=seg.offset;p+4<=Math.min(data.length,seg.offset+seg.size);p+=4){
    const w=data.readUInt32LE(p);if(((w&0xfc000000)>>>0)!==0x94000000)continue;
    let imm=w&0x3ffffff;if(imm&0x2000000)imm-=0x4000000;const dest=seg.address+p-seg.offset+imm*4;
    const field=candidates.includes(dest)?'protocolVersion':candidates.some(a=>a+8===dest)?'keyVersion':null;if(!field)continue;
    const n=constantBefore(p,seg);if(Number.isInteger(n)&&n>0&&n<65536)values[field].add(n);
  }
  return Object.fromEntries(Object.entries(values).map(([k,v])=>[k,[...v].sort((a,b)=>a-b)]));
}
module.exports.extractHelloConstants=extractHelloConstants;
