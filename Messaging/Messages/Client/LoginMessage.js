const ByteStream = require('../../../DataStream/ByteStream');
module.exports = class LoginMessage {
  constructor(config, account) {
    this.config = config;
    this.account = account;
    this.ByteStream = new ByteStream(512);
  }
  encode() {
    const c = this.config,
      a = this.account;
    this.ByteStream.writeInt(a.hi || 0);
    this.ByteStream.writeInt(a.lo || 0);
    this.ByteStream.writeOptionalString(a.passToken || a.token || null);
    this.ByteStream.writeInt(c.clientMajor ?? c.major);
    // Brawl Login::encode at RVA 0xf29d44 writes a literal 1 here.
    // This field differs from the zero used in ClientHello.
    this.ByteStream.writeInt(1);
    this.ByteStream.writeInt(c.clientBuild ?? c.build);
    // The hello carries the content SHA1; the login carries the native
    // "files content update" marker instead (RE-BODY §1, field #6).
    this.ByteStream.writeOptionalString(c.loginContentFp ?? c.fingerprintHash);
    this.ByteStream.writeOptionalString(a.deviceId ?? null); // native +0xe8
    // +0x100: runtime cache is empty at login time, so the id is 0 and the
    // instance is not written at all (1 byte on the wire, not 2).
    this.ByteStream.writeDataReference(0, 0);
    this.ByteStream.writeRequiredString(c.locale || 'en-US');
    this.ByteStream.writeOptionalString(a.advertisingId ?? null); // +0x108
    // +0x140: Native `Login::encode` writes a literal 1 here (0xbbec20, `mov w1,#1`).
    this.ByteStream.writeBoolean(c.loginFlagA ?? true);
    // +0x110: the native setter always writes the empty literal at 0x1c7b04.
    this.ByteStream.writeRequiredString(c.loginDeviceModel ?? '');
    // +0x120: filled from the JNI getAndroidID() result, never from osVersion.
    this.ByteStream.writeRequiredString(a.androidId ?? c.loginAndroidId ?? '');
    this.ByteStream.writeBoolean(true);
    this.ByteStream.writeOptionalString(a.openDeviceId ?? null); // +0x130
    this.ByteStream.writeInt(c.loginConnectionValue ?? 1448); // +0x13c: not yet recovered
    // +0x138: reads *(int*)0x1458af8, the same global the hello uses for appStore (== 2).
    // +0x138: the native filler copies the appStore global here, so the wire
    // value is a one-byte VInt (2 on a Play build). The license-derived
    // `loginClientSeed` is 32-bit and would add 4 bytes the client never sends.
    this.ByteStream.writeVInt(c.loginSeed ?? 2);
    this.ByteStream.writeRequiredString(`${c.clientMajor ?? c.major}.${c.clientBuild ?? c.build}`); // +0xd0
    this.ByteStream.writeRequiredString(''); // +0x148
    this.ByteStream.writeRequiredString(''); // +0x158
    // +0x168: never set by the native filler, so it serializes its default 0.
    this.ByteStream.writeVInt(c.loginAppStore ?? 0);
    this.ByteStream.writeRequiredString(''); // +0x178
    this.ByteStream.writeRequiredString(''); // +0x188
    this.ByteStream.writeRequiredString(''); // +0x198
    // +0x170 is a LogicCompressedString serialized as a nullable byte array.
    this.ByteStream.writeOptionalByteArray(
      a.loginCompressedBytesBase64 ? Buffer.from(a.loginCompressedBytesBase64, 'base64') : null,
    );
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
