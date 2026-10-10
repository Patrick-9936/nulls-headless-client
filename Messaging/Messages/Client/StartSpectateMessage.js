const ByteStream = require('../../../DataStream/ByteStream');
module.exports = class StartSpectateMessage {
  constructor(target, status = false) { this.target = target; this.status=status; this.ByteStream = new ByteStream(16); }
  encode() {
    this.ByteStream.writeLong(this.target.hi, this.target.lo);
    // Native lobby spectator flag is 0; after-death spectator flow uses 1.
    this.ByteStream.writeByte(this.status ? 1 : 0);
  }
};
