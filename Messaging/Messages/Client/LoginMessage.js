const ByteStream = require('../../../DataStream/ByteStream');
module.exports = class LoginMessage {
  constructor(config, account) { this.config = config; this.account = account; this.ByteStream = new ByteStream(512); }
  encode() {
    const c = this.config, a = this.account;
    this.ByteStream.writeInt(a.hi || 0);
    this.ByteStream.writeInt(a.lo || 0);
    this.ByteStream.writeOptionalString(a.passToken || a.token || null);
    this.ByteStream.writeInt(c.clientMajor ?? c.major);
    // Brawl Login::encode at RVA 0xf29d44 writes a literal 1 here.
    // This field differs from the zero used in ClientHello.
    this.ByteStream.writeInt(1);
    this.ByteStream.writeInt(c.clientBuild ?? c.build);
    this.ByteStream.writeOptionalString(c.fingerprintHash);
    this.ByteStream.writeOptionalString(a.deviceId ?? null); // native +0xe8
    this.ByteStream.writeDataReference(1, 0);
    this.ByteStream.writeRequiredString(c.locale || 'en-US');
    this.ByteStream.writeOptionalString(a.advertisingId ?? null); // +0x108
    this.ByteStream.writeBoolean(false);
    this.ByteStream.writeRequiredString(a.deviceModel || 'Android'); // +0x110
    this.ByteStream.writeRequiredString(a.osVersion || ''); // +0x120
    this.ByteStream.writeBoolean(true);
    this.ByteStream.writeOptionalString(a.openDeviceId ?? null); // +0x130
    this.ByteStream.writeInt(c.loginConnectionValue ?? 1448); // +0x13c: not yet recovered
    this.ByteStream.writeVInt(c.loginClientSeed ?? 0);
    this.ByteStream.writeRequiredString(`${c.clientMajor ?? c.major}.${c.clientBuild ?? c.build}`); // +0xd0
    this.ByteStream.writeRequiredString(''); // +0x148
    this.ByteStream.writeRequiredString(''); // +0x158
    this.ByteStream.writeVInt(c.appStore ?? 2); // +0x168
    this.ByteStream.writeRequiredString(''); // +0x178
    this.ByteStream.writeRequiredString(''); // +0x188
    this.ByteStream.writeRequiredString(''); // +0x198
    // +0x170 is a LogicCompressedString serialized as a nullable byte array.
    this.ByteStream.writeOptionalByteArray(a.loginCompressedBytesBase64
      ? Buffer.from(a.loginCompressedBytesBase64, 'base64') : null);
    this.ByteStream.writeBoolean(false);
    this.ByteStream.writeRequiredString(''); // +0x1b0
    this.ByteStream.writeRequiredString(''); // +0x1c0
    this.ByteStream.writeRequiredString(''); // +0x1d0
    this.ByteStream.writeRequiredString(''); // +0x1e0
    this.ByteStream.writeRequiredString(''); // +0x1f0
    this.ByteStream.writeRequiredString(''); // +0x200
    this.ByteStream.writeRequiredString(''); // base +0x90
    this.ByteStream.writeRequiredString(''); // base +0xa0
  }
};
