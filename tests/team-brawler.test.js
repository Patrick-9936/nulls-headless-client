'use strict';
// 14375 — выбор бойца в лобби. Эталон снят с libg 69.252: encode 0xf35ba8,
// writer 0x5b7334 = writeInt32 (big-endian), поля: слот участника, числовой id бойца.
const test = require('node:test');
const assert = require('node:assert/strict');
const Protocol = require('../lib/Protocol');
const Actions = require('../lib/Actions');
const { AppError } = require('../lib/Errors');

test('team-brawler: эталонные байты slot=0, brawler=16000000', () => {
  const message = Protocol.encode('team-brawler', { slot: 0, brawler: 16000000 });
  assert.equal(message.id, 14375);
  assert.equal(message.version, 23);
  assert.equal(message.payload.toString('hex'), '0000000000f42400');
});

test('team-brawler: ссылка 16:N переводится в числовой id каталога', () => {
  const message = Protocol.encode('team-brawler', { brawler: '16:5' });
  assert.equal(message.payload.toString('hex'), '0000000000f42405');
  assert.equal(Protocol.brawlerNumber('16:0'), 16000000);
  assert.equal(Protocol.brawlerIndex('16:5'), 5);
  assert.equal(Protocol.brawlerIndex(16000007), 7);
});

test('team-brawler: проверка аргументов', () => {
  assert.throws(() => Protocol.encode('team-brawler', { brawler: 0 }), /brawler/);
  assert.throws(() => Protocol.encode('team-brawler', { brawler: 'abc' }), /brawler/);
  assert.throws(() => Protocol.encode('team-brawler', { brawler: 16000000, slot: 3 }), /slot/);
  assert.throws(() => Protocol.encode('team-brawler', { brawler: 16000000, slot: -1 }), /slot/);
});

test('team-brawler: команда в каталоге и помечена экспериментальной', () => {
  assert.ok(Actions.commands.includes('team-brawler'));
  const feature = require('../docs/features.json').commands.find((c) => c.command === 'team-brawler');
  assert.equal(feature?.status, 'experimental');
  assert.equal(feature?.experimental, true);
});

test('team-brawler: подтверждение по TeamData и отказ сервера', async () => {
  const own = { hi: 1, lo: 2 };
  const sent = [];
  const client = {
    account: own,
    team: { members: [{ ...own, brawler: { class: 16, index: 5 } }] },
    request: async (command, args, options) => {
      sent.push({ command, args, options });
      return { command, confirmed: true, response: 24124 };
    },
  };
  const result = await Actions.execute(client, 'team-brawler', {
    brawler: '16:5',
    experimental: true,
  });
  assert.equal(result.confirmed, true);
  assert.deepEqual(result.brawler, { class: 16, index: 5 });
  assert.equal(result.slot, 0);
  assert.equal(sent[0].command, 'team-brawler');
  assert.deepEqual(sent[0].options.types, [24124]);

  client.team = { members: [{ ...own, brawler: { class: 16, index: 0 } }] };
  await assert.rejects(
    () => Actions.execute(client, 'team-brawler', { brawler: '16:5', experimental: true }),
    (error) => error instanceof AppError && /не подтвердил выбор бойца/.test(error.message),
  );
});
