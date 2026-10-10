const ByteStream = require('../../../DataStream/ByteStream');

module.exports = class ModernLoginMessage {
  constructor(config, account){ this.config=config; this.account=account; this.ByteStream=new ByteStream(1024); }
  encode(){
    const c=this.config, a=this.account;
    this.ByteStream.writeLong(a.hi || 0, a.lo || 0);
    this.ByteStream.writeOptionalString(a.passToken || a.token || null);
    this.ByteStream.writeOptionalString(c.fingerprintHash || null);
    const vMajor=c.clientMajor ?? c.major, vMinor=c.clientMinor ?? c.minor, vBuild=c.clientBuild ?? c.build;
    const loginVersion=((vMajor & 0x7ff) << 20) | ((vMinor & 0x3ff) << 10) | (vBuild & 0x3ff);
    this.ByteStream.writeInt(loginVersion);
    this.ByteStream.writeOptionalString(a.deviceId || '');
    this.ByteStream.writeOptionalString(a.openDeviceId || a.deviceId || '');
    this.ByteStream.writeOptionalString(null); // MAC
    this.ByteStream.writeOptionalString(a.deviceModel || 'Android');
    this.ByteStream.writeOptionalString(null); // advertising id
    this.ByteStream.writeBoolean(true);
    this.ByteStream.writeOptionalString(a.osVersion || '');
    this.ByteStream.writeRequiredString('');
    this.ByteStream.writeRequiredString(a.androidId || a.deviceId || '');
    this.ByteStream.writeRequiredString(c.preferredLanguage || 'en');
    this.ByteStream.writeRequiredString('');
    this.ByteStream.writeBoolean(true);
    this.ByteStream.writeRequiredString(a.idForVendor || a.deviceId || '');
    this.ByteStream.writeInt(c.appStore ?? 2);
    const session = a.sessionTokenBase64 ? Buffer.from(a.sessionTokenBase64,'base64') : null;
    this.ByteStream.writeOptionalByteArray(session);
    this.ByteStream.writeRequiredString(c.storefrontCountryCode || '');
    this.ByteStream.writeRequiredString(c.storefrontId || '');
  }
};
