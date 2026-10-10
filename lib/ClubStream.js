const S = require('../DataStream/ByteStream');
const P = require('./Protocol');
const Tag = require('../utils/TagCodec');
const vintLong = s => ({hi: s.readVInt() >>> 0, lo: s.readVInt() >>> 0});
function display(s) {return {name: s.readString(), fields: Array.from({length: 4}, () => s.readVInt()), flag: s.readBoolean(), extra: [s.readVInt(), s.readVInt()]};}
function entry(s) {
  const type = s.readVInt();
  const value = {type, entryId: vintLong(s), player: vintLong(s), name: s.readString(), role: s.readVInt(), age: s.readVInt(), flag: s.readBoolean()};
  value.player.tag = Tag.logicLongToTag(value.player.hi, value.player.lo);
  if (type === 2) {value.text = s.readString(); value.pinned = s.readBoolean();}
  else if (type === 3) {value.text = s.readString(); value.responderName = s.readString(); value.state = s.readVInt(); value.display = display(s);}
  else if (type === 4) {
    value.event = s.readVInt(); value.argument = s.readVInt();
    if (s.readBoolean()) {value.target = vintLong(s); value.targetName = s.readString();}
    value.targetRole = s.readVInt(); value.extra = (s.readByte() << 8) | s.readByte();
  } else if (type === 6) value.reference = P.readReference(s);
  else if (type === 8) {
    value.reference = P.readReference(s); if (s.readBoolean()) value.team = s.readLong();
    value.text = s.readString(); value.fields = [s.readVInt(), s.readVInt()];
  } else throw new Error(`Неподдерживаемая запись ленты типа ${type}`);
  return value;
}
function decode(type, bytes) {
  const s = new S(); s.set(bytes);
  const n = type === 24312 ? 1 : s.readVInt();
  if (n < -1 || n > 1000) throw new Error('Неверный размер ленты клуба');
  const entries = Array.from({length: Math.max(0, n)}, () => entry(s));
  if (s.remaining()) throw new Error(`Лишние байты ленты: ${s.remaining()}`);
  return {entries, complete: true};
}
module.exports = {decode, entry};
