const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const ByteStream = require('../DataStream/ByteStream'), Decode = require('../lib/Decode');
const Protocol = require('../lib/Protocol'), Actions = require('../lib/Actions'), Client = require('../lib/Client');
function response() {
  const s = new ByteStream(); s.writeVInt(2);
  for (const [lo, name] of [[48607939, 'КочБратаны'], [48607940, 'Другой клуб']]) {
    s.writeLong(0, lo); s.writeString(name); s.writeDataReference(8, 1);
    for (const n of [1, 12, 30000, 1000]) s.writeVInt(n);
    s.writeDataReference(14, 125); s.writeString('KZ'); s.writeVInt(0); s.writeVInt(0);
    s.writeBoolean(true); s.writeVInt(0); s.writeVInt(1); s.writeVInt(2); s.writeVInt(3); s.writeVInt(0);
  }
  return s.getBytes();
}
test('recommendations use 14303 v9 with the native default selector and preserve complete server club records in order', () => {
  const packet = Protocol.encode('club-recommendations');
  assert.equal(packet.id, 14303); assert.equal(packet.version, 9); assert.equal(packet.payload.toString('hex'), '00');
  const clubs = Decode.recommendedClubs(response());
  assert.deepEqual(clubs.map(c => c.name), ['КочБратаны', 'Другой клуб']);
  assert.equal(clubs[0].tag, require('../utils/TagCodec').logicLongToTag(0, 48607939));
  assert.equal(clubs[0].memberCount, 12); assert.equal(clubs[0].requiredTrophies, 1000);
  assert.deepEqual(clubs[0].region, {class: 14, index: 125});
  assert.deepEqual(clubs[0].seasonFields, [2, 3]); assert.equal(clubs[0].familyFriendly, true);
  assert.deepEqual(Decode.recommendedClubs(Buffer.from([0])), []);
  assert.deepEqual(Decode.recommendedClubs(Buffer.from([0x7f])), []);
});
test('recommendations reject incomplete records, invalid counts and unknown tails', () => {
  const payload = response();
  for (let i = 0; i < payload.length; i++) assert.throws(() => Decode.recommendedClubs(payload.subarray(0, i)));
  assert.throws(() => Decode.recommendedClubs(Buffer.concat([payload, Buffer.from([0])])), /Лишние данные/);
  for (const n of [-2, 1001]) {const s = new ByteStream(); s.writeVInt(n); assert.throws(() => Decode.recommendedClubs(s.getBytes()), /размер списка/);}
});
test('fresh 24304 confirms recommendations; malformed reply, refusal and disconnect fail the action', async () => {
  const client = new Client({root: path.resolve(__dirname, '..')}); client.state = 'online';
  const warnings = []; client.on('warning', e => warnings.push(e));
  client.messaging = {send(id) {assert.equal(id, 14303); client._packet(24304, response());}};
  const result = await Actions.execute(client, 'club-recommendations');
  assert.equal(result.confirmed, true); assert.equal(result.source, 'server-recommendations'); assert.equal(result.response, 24304);
  assert.deepEqual(client.recommendedClubs, result.clubs);
  client.messaging.send = () => client._packet(24304, Buffer.from([1]));
  await assert.rejects(Actions.execute(client, 'club-recommendations'), /EOF/);
  client.messaging.send = () => client._packet(24332, Buffer.from([1]));
  await assert.rejects(Actions.execute(client, 'club-recommendations'), /отклонил/);
  client.messaging.send = () => {for (const item of [...client.pending]) item.reject(new Error('Соединение прервано'));};
  await assert.rejects(Actions.execute(client, 'club-recommendations'), /прервано/);
  assert.equal(client.pending.size, 0); assert.equal(warnings.length, 1);
});

test('captured 24304 decodes all 50 recommended clubs without losing server order', () => {
  const clubs = Decode.recommendedClubs(fs.readFileSync(path.join(__dirname, 'fixtures/recommended-clubs.bin')));
  assert.equal(clubs.length, 50); assert.equal(clubs[0].tag, '#GL0QVU0G0'); assert.equal(clubs.at(-1).tag, '#GYR8R8VJ0');
  assert.equal(clubs[0].name, 'Execelente'); assert.equal(clubs[0].memberCount, 13);
  assert.equal(clubs[0].trophies, 8028963); assert.equal(clubs[0].region, null);
  assert.ok(clubs.every(c => c.complete && c.tag && typeof c.name === 'string'));
});
