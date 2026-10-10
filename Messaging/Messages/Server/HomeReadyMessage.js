const ByteStream = require('../../../DataStream/ByteStream');
module.exports = class HomeReadyMessage {
  constructor() { this.ByteStream = new ByteStream(); }
  decode() {}
  process(messaging) { messaging.onHomeReady(this.ByteStream.payload); }
};
