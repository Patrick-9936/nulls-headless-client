const ByteStream=require('../../../DataStream/ByteStream');
module.exports=class ChangeNameMessage {
  constructor(name, firstName=false) { this.name=name; this.firstName=firstName; this.ByteStream=new ByteStream(); }
  encode() {
    if (!this.name || Buffer.byteLength(this.name,'utf8')>60) throw new Error('Nickname must contain 1–60 UTF-8 bytes');
    this.ByteStream.writeRequiredString(this.name);
    this.ByteStream.writeBoolean(this.firstName);
  }
};
