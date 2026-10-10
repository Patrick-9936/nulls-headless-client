const ByteStream=require('../../../DataStream/ByteStream');
// Native LogicSetPlayerAgeCommand: type 530, embedded in EndClientTurn 14102.
module.exports=class SetAgeMessage {
  constructor(age,tick=1) { this.age=age; this.tick=tick; this.ByteStream=new ByteStream(); }
  encode() {
    if (!Number.isInteger(this.age) || this.age<19 || this.age>99) throw new Error('Bot age must be 19–99');
    const s=this.ByteStream;
    s.writeBoolean(false);
    s.writeVInt(this.tick);
    s.writeVInt(1);
    s.writeVInt(530);
    s.writeVInt(0);
    s.writeVInt(0);
    s.writeVInt(0); s.writeVInt(0);
    s.writeInt(this.age);
    s.writeOptionalByteArray(null);
  }
};
