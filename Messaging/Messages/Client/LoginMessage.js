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
    if (c.loginBodyProfile === 'libwire') return this.encodeLibWire();
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

  // Byte-for-byte reconstruction of the real Login::encode recovered from
  // libg.so (RVA 0xe464e8) — see docs/V70-LOGIN-RE.md. Field ORDER and TYPES
  // are taken straight from the disassembly; values of the first fields
  // (accountId, token, version, build, fingerprint, device ids) are mapped with
  // confidence, the trailing strings are best-effort (empty) pending the
  // populate-function reversal. The decisive structural difference from the
  // native70 profile: accountId is a LogicLong written as two VInts, not two
  // fixed Int32s.
  encodeLibWire() {
    const c = this.config,
      a = this.account;
    const s = this.ByteStream;
    // 1  +0x80  LogicLong accountId (VInt hi, VInt lo)
    s.writeVInt(a.hi || 0);
    s.writeVInt(a.lo || 0);
    // 2  +0x84  OptionalString passToken
    s.writeOptionalString(a.passToken || a.token || null);
    // 3  +0x88  Int32 clientMajor
    s.writeInt(c.clientMajor ?? c.major);
    // 4         Int32 literal 1
    s.writeInt(1);
    // 5  +0x8c  Int32 clientBuild
    s.writeInt(c.clientBuild ?? c.build);
    // 6  +0xa0  OptionalString masterHash / content fingerprint
    s.writeOptionalString(c.loginContentFp ?? c.fingerprintHash);
    // 7  +0xa4  OptionalString deviceId
    s.writeOptionalString(a.deviceId ?? null);
    // 8  +0xb8  nullable reference (DataReference-like) — empty
    s.writeDataReference(0, 0);
    // 9  +0xa8  OptionalString openDeviceId
    s.writeOptionalString(a.openDeviceId ?? null);
    // 10 +0xbc  OptionalString advertisingId
    s.writeOptionalString(a.advertisingId ?? null);
    // 11 +0xec  Boolean
    s.writeBoolean(c.loginFlagA ?? false);
    // 12 +0xc0  RequiredString deviceModel
    s.writeRequiredString(c.loginDeviceModel ?? a.deviceModel ?? '');
    // 13 +0xd0  RequiredString androidId
    s.writeRequiredString(a.androidId ?? c.loginAndroidId ?? '');
    // 14 +0xed  Boolean
    s.writeBoolean(true);
    // 15 +0xe0  OptionalString
    s.writeOptionalString(null);
    // 16 +0xe8  Int32 connection value (+0x13c in the arm64 notes)
    s.writeInt(c.loginConnectionValue ?? 0);
    // 17 +0xe4  VInt seed
    s.writeVInt(c.loginSeed ?? 0);
    // 18 +0x90  RequiredString client version string
    s.writeRequiredString(`${c.clientMajor ?? c.major}.${c.clientBuild ?? c.build}`);
    // 19 +0xf0  RequiredString
    s.writeRequiredString('');
    // 20 +0x100 RequiredString
    s.writeRequiredString('');
    // 21 +0x110 VInt appStore
    s.writeVInt(c.loginAppStore ?? 0);
    // 22 +0x118 RequiredString
    s.writeRequiredString('');
    // 23 +0x128 RequiredString
    s.writeRequiredString('');
    // 24 +0x138 RequiredString
    s.writeRequiredString('');
    // 25 +0x114 LogicLong / 64-bit — empty
    s.writeVInt(0);
    s.writeVInt(0);
    // 26 +0x148 Boolean
    s.writeBoolean(false);
    // 27..34  +0x14c/+0x15c/+0x16c/+0x17c/+0x18c/+0x19c/+0x5c/+0x6c RequiredString
    for (let i = 0; i < 8; i++) s.writeRequiredString('');
  }
};
