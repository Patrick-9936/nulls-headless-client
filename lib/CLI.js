const path = require('node:path');
const {parse} = require('./Args');
const Store = require('./Store');
const Protocol = require('./Protocol');
const Actions = require('./Actions');
const Client = require('./Client');
const ROOT = path.resolve(__dirname, '..');
const print = value => console.log(JSON.stringify(value, null, 2));

async function main(argv = process.argv.slice(2)) {
  const {options, positional} = parse(argv); const command = positional[0] || 'help';
  if (command === 'help') {
    console.log('Nulls Headless Client 0.2.6\n\n' +
      'node Program.js <команда> --account accounts/bot-1.json [параметры]\n' +
      'Команды: ' + Actions.commands.join(', ') + '\n\n' +
      'Утилиты: info, account-info, tag-decode, tag-encode, room-code, update, modes, regions, club-badges, features\n' +
      'Несколько ботов: node tools/fleet.js start --first 1 --count 13 --club-tag "#TAG"\n' +
      'Команда онлайн-боту: node tools/fleet.js command --bot 1 --action chat --text "Привет"\n' +
      'Полные примеры: README.md, docs/COMMANDS.md, docs/VERIFICATION.md'); return;
  }
  if (command === 'update') {await require('../utils/AutoUpdate').main(ROOT, argv.slice(1)); return;}
  if (command === 'info') {const c = Store.read(path.join(ROOT, 'config.json')); print({version: '0.2.6', host: c.host, binary: c.appBinaryVersion, content: `${c.major}.${c.minor}.${c.build}`, cryptoMode: c.cryptoMode}); return;}
  if (command === 'features') {print(Store.read(path.join(ROOT, 'docs/features.json'), {commands: Actions.commands})); return;}
  if (command === 'account-info') {
    const account = Store.read(path.resolve(ROOT, options.account || 'account.json'), {});
    print({tag: account.lo ? require('../utils/TagCodec').logicLongToTag(account.hi, account.lo) : null,
      name: account.name || null, club: account.club || null, team: account.team || null, saved: !!account.passToken}); return;
  }
  if (command === 'tag-decode') {print(require('../utils/TagCodec').describeTag(positional[1] || options.tag)); return;}
  if (command === 'room-code') {
    const codec = require('../utils/TeamCode');
    const room = options.code || positional[1] ? codec.decode(options.code || positional[1]) : {hi: Number(options.high || 0), lo: Number(options.low)};
    const offset = Protocol.integer(options.offset || 0, 'offset', -0x7fffffff, 0x7fffffff);
    const lo = room.lo + offset; print({hi: room.hi, lo, code: codec.encode(room.hi, lo), note: 'Кодирует ID; существование и порядок создания комнат не определяются'}); return;
  }
  if (command === 'tag-encode') {
    const Tag = require('../utils/TagCodec');
    print({tag: options.encodedId ? Tag.encodedIdToTag(BigInt(options.encodedId)) : Tag.logicLongToTag(Number(options.high), Number(options.low))}); return;
  }
  if (['regions', 'club-badges'].includes(command)) {print(Store.read(path.join(ROOT, command === 'regions' ? 'data/regions.json' : 'data/club-badges.json'), [])); return;}
  if (command === 'modes') {
    let values = Store.read(path.join(ROOT, 'data/maps.json'), []);
    if (options.mode) values = values.filter(v => v.mode.toLowerCase().includes(options.mode.toLowerCase()));
    print({source: 'locations.csv предоставленного клиента v69.252', note: 'Каталог карт; доступность сервером проверяется при выборе', maps: values}); return;
  }
  if (!Actions.commands.includes(command)) throw new Error(`Неизвестная команда ${command}; см. help`);
  if (options.dryRun) {
    if (['login', 'create-account', 'team-info', 'club-members', 'club-online', 'friends-online', 'club-description', 'club-trophies', 'club-promote', 'club-demote', 'club-settings', 'team-mode', 'team-map', 'invitations', 'account-region', 'club-stream', 'club-requests', 'club-answer'].includes(command)) {
      print({command, options, network: false}); return;
    }
    const wireCommand = command === 'brawl-tv' && !options.tag ? (options.channel !== undefined ? 'brawl-tv-next' : 'brawl-tv-channels') : command;
    const packet = Protocol.encode(wireCommand === 'matchmake' ? 'ready' : wireCommand, options);
    print({command, packetId: packet.id, payloadHex: packet.payload.toString('hex'), network: false}); return;
  }
  const accountPath = path.resolve(ROOT, options.account || 'account.json');
  const existing = Store.read(accountPath, {});
  if (command === 'create-account' && (existing.hi || existing.lo)) throw new Error('Аккаунт уже существует. Выберите новый путь --account, старый сохранён');
  if (!existing.lo && !existing.hi && !options.name) throw new Error('Для нового аккаунта укажите --name');
  if (existing.name && options.name && existing.name !== options.name) throw new Error('Смена уже заданного ника удалена: --name задаёт имя только при создании аккаунта');
  const client = new Client({root: ROOT, ...options, name: options.name, reconnect: !options.once && command === 'login'});
  global.Debugger = {info: (...args) => console.error(...args), warn: (...args) => console.error(...args), error: (...args) => console.error(...args)};
  client.on('warning', error => console.error(error.message));
  const stop = () => client.close(); process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    await client.connect();
    const result = await Actions.execute(client, command, options); print(result);
    if (result.confirmed === false) process.exitCode = 2;
    if (options.once || result.stage === 'external-stream' || !['login', 'spectate', 'brawl-tv', 'create-room', 'join-room', 'matchmake'].includes(command)) client.close();
  } catch (error) {client.close(); throw error;}
}
module.exports = {main};
