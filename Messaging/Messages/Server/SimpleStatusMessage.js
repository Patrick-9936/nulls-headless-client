const ByteStream = require('../../../DataStream/ByteStream');
module.exports = class SimpleStatusMessage {
  constructor(name) { this.name = name; this.ByteStream = new ByteStream(); }
  decode() {}
  process() { Debugger.info(this.name); }
};
