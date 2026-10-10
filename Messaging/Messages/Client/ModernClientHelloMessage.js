const ByteStream = require('../../../DataStream/ByteStream');

module.exports = class ModernClientHelloMessage {
  constructor(config) { this.config=config; this.ByteStream=new ByteStream(160); }
  encode(){
    const c=this.config;
    this.ByteStream.writeInt(c.protocolVersion ?? 2);
    this.ByteStream.writeInt(c.keyVersion ?? 59);

    // App/client version is independent from the downloadable fingerprint version.
    // Use the APK tuple here; fingerprintHash still identifies content.
    this.ByteStream.writeInt(c.clientMajor ?? c.major);
    this.ByteStream.writeInt(c.clientMinor ?? c.minor);
    this.ByteStream.writeInt(c.clientBuild ?? c.build);

    this.ByteStream.writeRequiredString(c.fingerprintHash || '');
    this.ByteStream.writeInt(c.deviceType ?? 2);
    this.ByteStream.writeInt(c.appStore ?? 2);

    // v69 ClientHello::encode ends with a nullable byte array (libg 0xae5c50).
    // The stock constructor leaves its pointer null, encoded as int32 -1.
    const extra = typeof c.createHelloExtra==='function' ? c.createHelloExtra()
      : c.helloExtraBase64 == null ? null : Buffer.from(c.helloExtraBase64, 'base64');
    this.ByteStream.writeOptionalByteArray(extra);
  }
};
