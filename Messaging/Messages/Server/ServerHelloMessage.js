const ByteStream = require('../../../DataStream/ByteStream');
module.exports = class ServerHelloMessage {
  constructor() { this.ByteStream = new ByteStream(); }
  decode() {}
  process(messaging) { messaging.sendPepperLogin(); }
};
