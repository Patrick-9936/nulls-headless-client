const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const P = require('../lib/Protocol');
const D = require('../lib/Decode');
const A = require('../lib/Actions');
const CS = require('../lib/ClubStream');
const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures', name + '-v69.bin'));

test('captured club applications preserve their stream ID, text and approved/declined state', () => {
  const pending = CS.decode(24312, fixture('club-request-pending')).entries[0];
  const accepted = CS.decode(24312, fixture('club-request-approved')).entries[0];
  const declined = CS.decode(24312, fixture('club-request-declined')).entries[0];
  assert.equal(pending.text, 'Please accept QA bot');
  assert.equal(pending.state, 1); assert.equal(accepted.state, 2); assert.equal(declined.state, 3);
  assert.deepEqual(accepted.entryId, pending.entryId);
  assert.notEqual(pending.entryId.lo, pending.player.lo);
  assert.equal(accepted.responderName, 'EndyVerify');
  const m = P.encode('club-answer', {entryId: pending.entryId, accept: true});
  const s = D.stream(m.payload); assert.deepEqual(s.readLong(), pending.entryId); assert.equal(s.readBoolean(), true);
});
test('club request requires text and cannot answer an application with a player ID', () => {
  assert.throws(() => P.encode('club-request', {clubTag: {hi:0,lo:1}}), /text/);
  assert.throws(() => P.encode('club-answer', {tag: {hi:0,lo:1}}), /ID записи/);
});
test('captured club history handles mixed chat, application and two-byte event fields', () => {
  const entries = CS.decode(24311, fixture('club-stream')).entries;
  assert.ok(entries.some(e => e.type === 2)); assert.ok(entries.some(e => e.type === 3)); assert.ok(entries.some(e => e.type === 4));
  assert.ok(entries.every(e => e.entryId && e.player && e.name));
});
test('lobby request targets player first, team second, and decodes pending requester profiles', () => {
  const team = D.team(fixture('team-request')), request = team.requests[0];
  assert.equal(team.complete, true); assert.equal(team.parseWarning, undefined);
  assert.equal(request.owner.lo, team.members[0].lo); assert.equal(request.profile.lo, request.player.lo);
  const message = P.encode('team-request', {tag: request.owner, code: team.code});
  const s = D.stream(message.payload); assert.deepEqual(s.readLong(), P.target(request.owner)); assert.deepEqual(s.readLong(), P.target(team));
  assert.equal(s.remaining(), 0);
});
test('server snapshots expose disabled built-in bot slots and team member status', () => {
  assert.deepEqual(D.team(fixture('team-bot-disabled')).disabledSlots, [1]);
  assert.equal(D.team(fixture('team-member-status')).members[0].status, 2);
});
test('account country is confirmed only by successful matching server DataReference', async () => {
  const result = D.stream(fixture('account-region-result'));
  assert.equal(result.readVInt(), 0); assert.deepEqual(P.readReference(result), {class:14,index:249});
  assert.equal(P.encode('account-region', {region:'14:249'}).id, 12998);
  const client = {async request() {return {confirmed:true,response:24178};}, regionResult:{code:1,region:{class:14,index:249}}};
  await assert.rejects(() => A.execute(client, 'account-region', {region:'US'}), /не подтвердил/);
  client.regionResult = {code:0,region:{class:14,index:125}};
  await assert.rejects(() => A.execute(client, 'account-region', {region:'US'}), /не подтвердил/);
  client.regionResult = {code:0,region:{class:14,index:249}};
  assert.equal((await A.execute(client, 'account-region', {region:'US'})).country, 'US');
});
test('club stream is read from the current server session without inventing a request ACK', async () => {
  const entries = CS.decode(24311, fixture('club-stream')).entries;
  const value = await A.execute({clubStreamReady:true,clubStream:entries}, 'club-requests');
  assert.equal(value.confirmed, true); assert.ok(value.entries.every(e => e.type === 3 && e.state === 1));
});
test('club application waits for sender ACK and owner entry; duplicate/refusal cannot confirm new text', async () => {
  const Client = require('../lib/Client'), {EventEmitter} = require('node:events');
  const pending = CS.decode(24312, fixture('club-request-pending')).entries[0];
  function fake(account, club = null) {
    const c = Object.create(Client.prototype); EventEmitter.call(c);
    Object.assign(c, {account,club,state:'online',pending:new Set(),config:{packetIds:{}},clubStream:[],save(){}}); return c;
  }
  const owner = fake({hi:0,lo:900}, {hi:0,lo:48610317}), sender = fake(pending.player);
  sender.peers = new Map([[1,owner]]);
  sender.messaging = {send(){sender._packet(24333, Buffer.from('3200','hex')); owner._packet(24312, fixture('club-request-pending'));}};
  const result = await A.execute(sender, 'club-request', {clubTag:owner.club,text:pending.text,timeout:100});
  assert.equal(result.confirmed,true); assert.equal(result.textVerified,true); assert.equal(result.stage,'pending');
  sender.peers.clear(); sender.messaging.send=()=>sender._packet(24333,Buffer.from('3400','hex'));
  const duplicate = await A.execute(sender, 'club-request', {clubTag:owner.club,text:'different text',timeout:100});
  assert.equal(duplicate.confirmed,false); assert.equal(duplicate.alreadyPending,true);
  sender.messaging.send=()=>sender._packet(24333,Buffer.from('0b00','hex'));
  await assert.rejects(() => A.execute(sender, 'club-request', {clubTag:owner.club,text:'different text',timeout:100}), /не подтвердил/);
});
