const ByteStream = require('../../../DataStream/ByteStream');
module.exports = class ClientHelloMessage {
  constructor(config) { this.config = config; this.ByteStream = new ByteStream(128); }
  encode() {
    const c = this.config;
    this.ByteStream.writeInt(c.protocolVersion);
    this.ByteStream.writeInt(c.cryptoVersion ?? c.keyVersion ?? 48);
    this.ByteStream.writeInt(c.clientMajor ?? c.major);
    this.ByteStream.writeInt(c.clientBuild ?? c.build);
    this.ByteStream.writeInt(c.clientMinor ?? c.minor);
    this.ByteStream.writeString(c.fingerprintHash);
    for (const x of c.helloTail || []) this.ByteStream.writeInt(x);
  }
};
