const ByteStream=require('../DataStream/ByteStream');
function create(name){
  const s=new ByteStream(); s.writeRequiredString(name); s.writeRequiredString('');
  s.writeDataReference(8,0); s.writeDataReference(14,125);
  s.writeVInt(1); s.writeVInt(0); s.writeBoolean(true); s.writeBoolean(false);
  return s.getBytes();
}
function join(target){const s=new ByteStream();s.writeLong(target.hi,target.lo);s.writeBoolean(false);return s.getBytes();}
function info(target){const s=new ByteStream();s.writeLong(target.hi,target.lo);s.writeBoolean(false);return s.getBytes();}
function header(s){
  const id=s.readLong(),name=s.readString();
  const badgeClass=s.readVInt();if(badgeClass)s.readVInt();
  const type=s.readVInt(),memberCount=s.readVInt(),trophies=s.readVInt(),requiredTrophies=s.readVInt();
  return {...id,name,type,memberCount,trophies,requiredTrophies};
}
function decode(type,payload){
  const s=new ByteStream();s.set(payload);
  if(type===24301){const full=s.readBoolean();return {...header(s),full};}
  if(type===24399){const role=s.readVInt();if(!s.readBoolean())return {role,club:null};
    const badgeClass=s.readVInt();if(badgeClass)s.readVInt();return {role,club:header(s)};}
  throw new Error('Unsupported club response');
}
module.exports={create,join,info,decode};
