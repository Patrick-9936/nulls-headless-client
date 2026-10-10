module.exports = class ByteStream {
  constructor(size = 0) {
    this.payload = new Uint8Array(size || 0);
    this.offset = 0;
    this.booleanBit = 0;
  }
  set(obj) {
    if (typeof obj === 'number') this.payload = new Uint8Array(obj);
    else this.payload = new Uint8Array(obj || 0);
    this.offset = 0;
    this.booleanBit = 0;
  }
  remaining() { return this.payload.length - this.offset; }
  ensure(extra = 1) {
    if (this.offset + extra <= this.payload.length) return;
    const next = new Uint8Array(Math.max(this.payload.length * 2 || 64, this.offset + extra));
    next.set(this.payload);
    this.payload = next;
  }
  write(v) { this.booleanBit = 0; this.ensure(1); this.payload[this.offset++] = v & 0xff; }
  read() {
    this.booleanBit = 0;
    if (this.offset >= this.payload.length) throw new Error('ByteStream EOF');
    return this.payload[this.offset++];
  }
  writeByte(v) { this.write(v); }
  writeBoolean(v) {
    if (!this.booleanBit) this.write(0);
    if (v) this.payload[this.offset - 1] |= 1 << this.booleanBit;
    this.booleanBit = (this.booleanBit + 1) & 7;
  }
  writeInt(v) {
    v = Number(v) >>> 0;
    this.ensure(4);
    this.write(v >>> 24); this.write(v >>> 16); this.write(v >>> 8); this.write(v);
  }
  writeUInt32(v) { this.writeInt(v); }
  writeLong(hi, lo) { this.writeInt(hi); this.writeInt(lo); }

  // Legacy strings encode null, undefined and empty as -1.
  writeString(v) {
    if (v === undefined || v === null || v === '') return this.writeInt(0xffffffff);
    const b = Buffer.from(String(v));
    this.writeInt(b.length);
    for (const x of b) this.write(x);
  }
  // Modern strings encode empty as 0 and null as -1.
  writeRequiredString(v = '') {
    const b = Buffer.from(String(v));
    this.writeInt(b.length);
    for (const x of b) this.write(x);
  }
  writeOptionalString(v) {
    if (v === undefined || v === null) return this.writeInt(0xffffffff);
    return this.writeRequiredString(v);
  }
  writeByteArray(v) {
    const b = Buffer.from(v || []);
    this.writeInt(b.length);
    for (const x of b) this.write(x);
  }
  writeOptionalByteArray(v) {
    if (v === undefined || v === null) return this.writeInt(0xffffffff);
    this.writeByteArray(v);
  }

  writeVInt(a1) {
    a1 |= 0;
    let v1 = (((a1 >> 25) & 0x40) | (a1 & 0x3f));
    let v2 = ((a1 ^ (a1 >> 31)) >> 6);
    a1 >>= 6;
    if (v2 === 0) return this.writeByte(v1);
    this.writeByte(v1 | 0x80);
    v2 >>= 7;
    let v3 = v2 > 0 ? 0x80 : 0;
    this.writeByte((a1 & 0x7f) | v3);
    a1 >>= 7;
    while (v2 !== 0) {
      v2 >>= 7;
      v3 = v2 > 0 ? 0x80 : 0;
      this.writeByte((a1 & 0x7f) | v3);
      a1 >>= 7;
    }
  }
  writeDataReference(a1, a2) { this.writeVInt(a1); if (a1 !== 0) this.writeVInt(a2); }

  readInt() { return ((this.read()<<24)|(this.read()<<16)|(this.read()<<8)|this.read()) | 0; }
  readUInt32() { return this.readInt() >>> 0; }
  readLong() { return { hi: this.readUInt32(), lo: this.readUInt32() }; }
  readByte() { return this.read(); }
  readBytes(size) {
    this.booleanBit = 0;
    if (size < 0 || size > this.remaining()) throw new Error(`Invalid byte length ${size}`);
    const out = this.payload.slice(this.offset, this.offset + size);
    this.offset += size;
    return out;
  }
  readBoolean() {
    if (!this.booleanBit) this.read();
    const value = !!(this.payload[this.offset - 1] & (1 << this.booleanBit));
    this.booleanBit = (this.booleanBit + 1) & 7;
    return value;
  }
  readVInt() {
    let b=this.read(), result=b&63, shift=6;
    const negative=!!(b&64);
    while (b&128) {
      if (shift>=32) throw new Error('Invalid VInt');
      b=this.read(); result|=(b&127)<<shift; shift+=7;
    }
    if (negative && shift<32) result|=(-1<<shift);
    return result|0;
  }
  readString() {
    const len = this.readUInt32();
    if (len === 0xffffffff) return '';
    if (len > this.remaining()) throw new Error(`Invalid string length ${len}`);
    return Buffer.from(this.readBytes(len)).toString();
  }
  readOptionalString() {
    const len = this.readUInt32();
    if (len === 0xffffffff) return null;
    if (len > this.remaining()) throw new Error(`Invalid string length ${len}`);
    return Buffer.from(this.readBytes(len)).toString();
  }
  readByteArray() {
    const len = this.readUInt32();
    if (len > this.remaining()) throw new Error(`Invalid byte array length ${len}`);
    return Buffer.from(this.readBytes(len));
  }
  getBytes() { return Buffer.from(this.payload.slice(0, this.offset)); }
};
