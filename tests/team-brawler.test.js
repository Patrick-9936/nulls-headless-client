'use strict';
// 14375 — выбор бойца в лобби. Эталон снят с libg 69.252: encode 0xf35ba8,
// writer 0x5b7334 = writeInt32 (big-endian), поля: слот участника, числовой id бойца.
const test = require('node:test');
const assert = require('node:assert/strict');
const Protocol = require('../lib/Protocol');
const Actions = require('../lib/Actions');
const brawlers = require('../data/brawlers.json');
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

test('team-brawler: имя бойца из data/brawlers.json', () => {
  assert.deepEqual(
    brawlers.slice(0, 3).map((b) => b.name),
    ['ShotgunGirl', 'Gunslinger', 'BullDude'],
  );
  assert.equal(Protocol.brawlerNumber('ShotgunGirl'), 16000000);
  assert.equal(Protocol.brawlerNumber('Gunslinger'), 16000001);
  assert.equal(Protocol.brawlerNumber('gUnSlInGeR'), 16000001);
  assert.equal(Protocol.brawlerIndex('BullDude'), 2);
  assert.equal(
    Protocol.encode('team-brawler', { brawler: 'Gunslinger', slot: 1 }).payload.toString('hex'),
    '0000000100f42401',
  );
  // Каждое имя каталога даёт ровно 16000000 + index.
  for (const brawler of brawlers)
    assert.equal(Protocol.brawlerNumber(brawler.name), 16000000 + brawler.index, brawler.name);
});

test('team-brawler: неизвестное имя отклоняется с подсказкой', () => {
  assert.throws(
    () => Protocol.brawlerNumber('Colt'),
    (error) => error instanceof AppError && /Неизвестный боец "Colt"/.test(error.message),
  );
  // Неполное имя попадает в подсказку «похожие».
  assert.throws(
    () => Protocol.brawlerNumber('gun'),
    (error) => error instanceof AppError && /Неизвестный боец/.test(error.message) && /Gunslinger/.test(error.message),
  );
  assert.throws(() => Protocol.brawlerIndex(''), /brawler/);
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

  // Имя бойца даёт тот же индекс, что и ссылка 16:N.
  client.team = { members: [{ ...own, brawler: { class: 16, index: 1 } }] };
  const byName = await Actions.execute(client, 'team-brawler', {
    brawler: 'Gunslinger',
    experimental: true,
  });
  assert.deepEqual(byName.brawler, { class: 16, index: 1 });
  assert.equal(sent[1].args.brawler, 'Gunslinger');

  client.team = { members: [{ ...own, brawler: { class: 16, index: 0 } }] };
  await assert.rejects(
    () => Actions.execute(client, 'team-brawler', { brawler: '16:5', experimental: true }),
    (error) =>
      error instanceof AppError &&
      /не подтвердил выбор бойца/.test(error.message) &&
      /16:0/.test(error.message) &&
      /16:5/.test(error.message),
  );

  client.team = { members: [] };
  await assert.rejects(
    () => Actions.execute(client, 'team-brawler', { brawler: '16:5', experimental: true }),
    (error) => error instanceof AppError && /внутри лобби/.test(error.message),
  );
});
