const crypto = require('crypto');
const V3 = require("./NaClV3");
const Native19 = require("./NativeCryptoPrimitives");

function parseKey(hex) {
  const clean=String(hex||'').replace(/\s+/g,'');
  if(!/^[0-9a-fA-F]{64}$/.test(clean)) throw new Error('serverPublicKeyHex must be 64 hex chars');
  return Buffer.from(clean,'hex');
}

class CounterNonce {
  constructor(bytes) {
    if(bytes) this.buf=Buffer.from(bytes);
    else { this.buf=crypto.randomBytes(24); this.buf[0]&=0xfe; }
    if(this.buf.length!==24) throw new Error('nonce must be 24 bytes');
  }
  increment(add=2){
    let carry=add;
    for(let i=0;i<24;i++){
      const sum=this.buf[i]+carry;
      this.buf[i]=sum&0xff;
      carry=sum>>>8;
      if(!carry) return;
    }
    throw new Error('nonce overflow');
  }
  bytes(){ return this.buf; }
}

module.exports=class ModernCrypto {
  constructor(config){
    this.config=config;
    this.primitives=config.cryptoMode==="native19"?Native19:V3;
    this.serverPublicKey=parseKey(config.serverPublicKeyHex);
    this.clientPrivateKey=crypto.randomBytes(32);
    this.clientPublicKey=this.primitives.scalarMultBase(this.clientPrivateKey);
    this.established=false;
  }

  isPlaintextOutbound(type){ return type===this.config.packetIds.clientHello; }
  isPlaintextInbound(type){
    // ServerHello is always plaintext. The server can also reject ClientHello
    // immediately with a plaintext LoginFailed before any session key exists.
    if(type===this.config.packetIds.serverHello) return true;
    if(type===this.config.packetIds.loginFailed && !this.sessionKey && !this.sendNonce) return true;
    return false;
  }

  _readServerHello(payload){
    const p=Buffer.from(payload);
    if(p.length<4) throw new Error('ServerHello too short');
    const len=p.readUInt32BE(0);
    if(len>p.length-4) throw new Error(`ServerHello session key length ${len} > payload`);
    this.sessionKey=p.subarray(4,4+len);
    if(!this.sessionKey.length) throw new Error('ServerHello has empty session key');
  }

  setChallengeResponse(response){
    const bytes=Buffer.from(response);
    if(!bytes.length || bytes.length>255) throw new Error('Challenge response must fit the native one-byte length');
    this.challengeResponse=bytes;
  }

  encrypt(type,payload){
    const body=Buffer.from(payload);
    if(this.isPlaintextOutbound(type)) return body;

    if(type===this.config.packetIds.login && !this.established){
      if(!this.sessionKey) throw new Error('No session key from ServerHello');
      this.sendNonce=new CounterNonce();
      const tempNonce=this.primitives.blake2b24(this.clientPublicKey,this.serverPublicKey);
      const response=this.config.cryptoMode==="native19"?this.challengeResponse:this.sessionKey;
      if(!response) throw new Error('Native SDK challenge response has not been prepared');
      const prefix=this.config.cryptoMode==="native19"?Buffer.from([response.length]):Buffer.alloc(0);
      const padded=Buffer.concat([
        prefix,
        response,
        this.sendNonce.bytes(),
        body,
        Buffer.alloc(this.config.promonPadSize ?? 508),
      ]);
      const encrypted=this.primitives.box(padded,tempNonce,this.serverPublicKey,this.clientPrivateKey);
      return Buffer.concat([this.clientPublicKey,encrypted]);
    }

    if(!this.established || !this.sharedKey || !this.sendNonce) throw new Error(`Crypto session is not established for outbound ${type}`);
    this.sendNonce.increment();
    return this.primitives.secretBox(body,this.sendNonce.bytes(),this.sharedKey);
  }

  decrypt(type,payload){
    const body=Buffer.from(payload);
    if(this.isPlaintextInbound(type)){
      if(type===this.config.packetIds.serverHello) this._readServerHello(body);
      return body;
    }

    if(!this.established){
      if(!this.sendNonce) throw new Error(`Encrypted handshake response ${type} arrived before Login was sent`);
      const nonce=this.primitives.blake2b24(this.sendNonce.bytes(),this.clientPublicKey,this.serverPublicKey);
      const plain=this.primitives.boxOpen(body,nonce,this.serverPublicKey,this.clientPrivateKey);
      if(!plain || plain.length<56) return null;
      this.receiveNonce=new CounterNonce(plain.subarray(0,24));
      this.sharedKey=Buffer.from(plain.subarray(24,56));
      this.established=true;
      return Buffer.from(plain.subarray(56));
    }

    if(!this.receiveNonce) throw new Error('Receive nonce not initialized');
    this.receiveNonce.increment();
    return this.primitives.secretBoxOpen(body,this.receiveNonce.bytes(),this.sharedKey);
  }
};
