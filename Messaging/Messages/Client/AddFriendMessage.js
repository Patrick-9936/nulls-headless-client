const ByteStream = require('../../../DataStream/ByteStream');
module.exports = class AddFriendMessage {
  constructor(target, reason = 0, reasonDetails = 0) {
    this.target = target;
    this.reason = reason;
    this.reasonDetails = reasonDetails;
    this.ByteStream = new ByteStream(32);
  }
  encode() {
    this.ByteStream.writeLong(this.target.hi, this.target.lo);
    this.ByteStream.writeInt(this.reason);
    this.ByteStream.writeInt(this.reasonDetails);
  }
};
