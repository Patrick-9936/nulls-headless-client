const ByteStream = require('../../../DataStream/ByteStream');

module.exports = class LoginOkMessage {
  constructor() { this.ByteStream = new ByteStream(); this.parsed=false; }

  decodeModern(){
    const s=this.ByteStream;
    this.loginResult=s.readVInt();
    this.unknown0=s.readVInt();
    this.loginVersion=s.readVInt();
    this.serverBuild=s.readVInt();
    this.unknown1=s.readBoolean();
    const a=s.readLong(); this.hi=a.hi; this.lo=a.lo;
    this.homeId=s.readLong();
    this.creationTimestamp=s.readString();
    this.creationTimestampTrunc=s.readString();
    this.token=s.readString();
    for(let i=0;i<4;i++) s.readOptionalString();
    this.countryCode=s.readString();
    this.eventAssetsUrl=s.readString();
    this.parsed=true; this.layout='modern-generic';
  }

  decodeLegacy(){
    const s=this.ByteStream;
    this.hi=s.readUInt32(); this.lo=s.readUInt32();
    s.readUInt32(); s.readUInt32();
    this.token=s.readString();
    this.parsed=true; this.layout='legacy';
  }

  decode(){
    const original=Buffer.from(this.ByteStream.payload);
    try { this.ByteStream.set(original); this.decodeModern(); return; } catch {}
    try { this.ByteStream.set(original); this.decodeLegacy(); return; } catch {}
    this.parsed=false;
  }

  process(messaging) {
    if(this.parsed){
      messaging.account.hi=this.hi;
      messaging.account.lo=this.lo;
      if(this.token){ messaging.account.passToken=this.token; messaging.account.token=this.token; }
      messaging.saveAccount();
      Debugger.info(`Login OK (${this.layout}): account=${this.hi}:${this.lo}`);
    } else {
      Debugger.warn('LoginOk packet recognized, but its v69 payload layout was not decoded. Raw packet can be saved with --dump.');
    }
    messaging.onLoggedIn();
  }
};
