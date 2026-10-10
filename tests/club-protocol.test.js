const test=require('node:test'), assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const Club=require('../utils/ClubProtocol'),ByteStream=require('../DataStream/ByteStream');
const fixture=n=>fs.readFileSync(path.join(__dirname,'fixtures',n));
test('Nulls club membership and detail fixtures decode the confirmed club',()=>{
 const c=Club.decode(24399,fixture('nulls-club-created.bin')).club;
 const d=Club.decode(24301,fixture('nulls-club-created-info.bin'));
 for(const x of [c,d]){assert.equal(x.hi,0);assert.equal(x.lo,48607939);assert.equal(x.name,'КочБратаны');assert.equal(x.memberCount,1);}
 const empty=Club.decode(24399,Buffer.alloc(4));assert.equal(empty.club,null);
 assert.throws(()=>Club.decode(24399,Buffer.from([0,1])),/EOF/);
});
test('Create club includes a valid region and join encodes the exact club ID',()=>{
 const s=new ByteStream();s.set(Club.create('КочБратаны'));
 assert.equal(s.readString(),'КочБратаны');assert.equal(s.readString(),'');
 assert.deepEqual([s.readVInt(),s.readVInt(),s.readVInt(),s.readVInt()],[8,0,14,125]);
 assert.deepEqual([s.readVInt(),s.readVInt()],[1,0]);assert.equal(s.readBoolean(),true);assert.equal(s.readBoolean(),false);assert.equal(s.remaining(),0);
 s.set(Club.join({hi:0,lo:48607939}));assert.deepEqual(s.readLong(),{hi:0,lo:48607939});assert.equal(s.readBoolean(),false);assert.equal(s.remaining(),0);
});
