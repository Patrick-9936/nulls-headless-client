const ByteStream = require('../../../DataStream/ByteStream');

// Login (10101) body encoder, 34 fields.
//
// Field *types* are identical to the v69 build whose login was live-verified
// against this server; only a handful of field *values* were changed for v70
// under the native-disassembly reading (see docs/V70-STATUS.md, RE-BODY).
// Because the v70 login is still rejected and only those values differ, they
// are grouped under `config.loginBodyProfile` so both readings can be tried
// without editing code:
//   "native70" (default) — the values recovered from Login::encode in libg70.
//   "legacy69"            — the exact values the live-verified v69 build sent,
//                           carried over unchanged except for the version/
//                           fingerprint fields, which are always v70.
// Individual fields stay overridable through their own config keys for sweeps
// (see tools/login-probe.js).
module.exports = class LoginMessage {
  constructor(config, account) {
    this.config = config;
    this.account = account;
    this.ByteStream = new ByteStream(512);
  }
  encode() {
    const c = this.config,
      a = this.account;
    const legacy = c.loginBodyProfile === 'legacy69';

    this.ByteStream.writeInt(a.hi || 0);
    this.ByteStream.writeInt(a.lo || 0);
    this.ByteStream.writeOptionalString(a.passToken || a.token || null);
    this.ByteStream.writeInt(c.clientMajor ?? c.major);
    // Brawl Login::encode at RVA 0xf29d44 writes a literal 1 here.
    // This field differs from the zero used in ClientHello.
    this.ByteStream.writeInt(1);
    this.ByteStream.writeInt(c.clientBuild ?? c.build);
    // field #6: native19 build sends the "files content update" marker here;
    // the v69 build sent the content SHA1 (fingerprintHash).
    this.ByteStream.writeOptionalString(legacy ? c.fingerprintHash : (c.loginContentFp ?? c.fingerprintHash));
    this.ByteStream.writeOptionalString(a.deviceId ?? null); // native +0xe8
    // +0x100 data reference. native19: empty cache -> (0,0), one byte on the
    // wire; v69: (1,0). Overridable via loginDataRefClass / loginDataRefId.
    this.ByteStream.writeDataReference(c.loginDataRefClass ?? (legacy ? 1 : 0), c.loginDataRefId ?? 0);
    this.ByteStream.writeRequiredString(c.locale || 'en-US');
    this.ByteStream.writeOptionalString(a.advertisingId ?? null); // +0x108
    // +0x140: native writes a literal 1 (0xbbec20, `mov w1,#1`); v69 sent false.
    this.ByteStream.writeBoolean(legacy ? false : (c.loginFlagA ?? true));
    // +0x110: native setter writes the empty literal (0x1c7b04); v69 sent the
    // device model.
    this.ByteStream.writeRequiredString(legacy ? a.deviceModel || 'Android' : (c.loginDeviceModel ?? ''));
    // +0x120: native fills this from JNI getAndroidID(); v69 sent osVersion.
    this.ByteStream.writeRequiredString(legacy ? a.osVersion || '' : (a.androidId ?? c.loginAndroidId ?? ''));
    this.ByteStream.writeBoolean(true);
    this.ByteStream.writeOptionalString(a.openDeviceId ?? null); // +0x130
    this.ByteStream.writeInt(c.loginConnectionValue ?? 1448); // +0x13c: not yet recovered
    // +0x138 seed: native copies the appStore global (one-byte VInt, 2 on a
    // Play build); v69 used the license-derived loginClientSeed.
    this.ByteStream.writeVInt(legacy ? (c.loginClientSeed ?? 0) : (c.loginSeed ?? 2));
    this.ByteStream.writeRequiredString(`${c.clientMajor ?? c.major}.${c.clientBuild ?? c.build}`); // +0xd0
    this.ByteStream.writeRequiredString(''); // +0x148
    this.ByteStream.writeRequiredString(''); // +0x158
    // +0x168 app store: native leaves the default 0; v69 sent 2.
    this.ByteStream.writeVInt(legacy ? (c.appStore ?? 2) : (c.loginAppStore ?? 0));
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
