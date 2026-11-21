const path = require('node:path');
const { parse } = require('./Args');
const Store = require('./Store');
const Protocol = require('./Protocol');
const Actions = require('./Actions');
const Client = require('./Client');
const I18N = require('./i18n');
const ROOT = path.resolve(__dirname, '..');
const VERSION = require('../package.json').version;
const print = (value) => console.log(JSON.stringify(value, null, 2));
const configPath = () => path.join(ROOT, 'config.json');

function readConfig() {
  return Store.read(configPath(), {});
}

// Сохраняем выбор языка, не трогая остальные ключи и их порядок.
function saveConfig(patch) {
  const config = { ...readConfig(), ...patch };
  Store.write(configPath(), config);
  return config;
}

function languageList(current) {
  return I18N.SUPPORTED.map((code) => ({ code, name: I18N.label(code), current: code === current }));
}

function unknownLanguage(requested) {
  return new Error(I18N.t('cli.error.unknownLanguage', { language: requested, supported: I18N.SUPPORTED.join(', ') }));
}

// Язык интерфейса: --lang -> config.uiLanguage -> NULLS_LANG/LANG -> ru.
function bootLanguage(options, config) {
  if (options.lang !== undefined) {
    const code = I18N.resolve(options.lang);
    if (!code) {
      I18N.setLanguage(I18N.detect({ config }));
      throw unknownLanguage(options.lang);
    }
    I18N.setLanguage(code);
    return;
  }
  I18N.setLanguage(I18N.detect({ config }));
}

async function main(argv = process.argv.slice(2)) {
  const { options, positional } = parse(argv);
  const command = positional[0] || 'help';
  const config = readConfig();
  bootLanguage(options, config);
  if (command === 'help') {
    console.log(
      [
        I18N.t('cli.help.title', { version: VERSION }),
        '',
        I18N.t('cli.help.usage'),
        I18N.t('cli.help.commands', { commands: Actions.commands.join(', ') }),
        '',
        I18N.t('cli.help.utilities'),
        I18N.t('cli.help.lang', { language: `${I18N.getLanguage()} (${I18N.label(I18N.getLanguage())})` }),
        I18N.t('cli.help.fleet'),
        I18N.t('cli.help.fleetCommand'),
        I18N.t('cli.help.docs'),
      ].join('\n'),
    );
    return;
  }
  if (command === 'lang' || command === 'language') {
    const requested = positional[1];
    if (!requested) {
      const current = I18N.getLanguage();
      print({
        language: current,
        name: I18N.label(current),
        message: I18N.t('cli.lang.current', { language: I18N.label(current) }),
        supported: languageList(current),
      });
      return;
    }
    const code = I18N.resolve(requested);
    if (!code) throw unknownLanguage(requested);
    saveConfig({ uiLanguage: code });
    I18N.setLanguage(code);
    print({
      language: code,
      name: I18N.label(code),
      saved: true,
      file: 'config.json',
      message: I18N.t('cli.lang.changed', { language: I18N.label(code) }),
      supported: languageList(code),
    });
    return;
  }
  if (command === 'update') {
    await require('../utils/AutoUpdate').main(ROOT, argv.slice(1));
    return;
  }
  if (command === 'info') {
    const c = config;
    print({
      version: VERSION,
      host: c.host,
      binary: c.appBinaryVersion,
      content: `${c.major}.${c.minor}.${c.build}`,
      cryptoMode: c.cryptoMode,
      language: I18N.getLanguage(),
    });
    return;
  }
  if (command === 'features') {
    print(Store.read(path.join(ROOT, 'docs/features.json'), { commands: Actions.commands }));
    return;
  }
  if (command === 'account-info') {
    const account = Store.read(path.resolve(ROOT, options.account || 'account.json'), {});
    print({
      tag: account.lo ? require('../utils/TagCodec').logicLongToTag(account.hi, account.lo) : null,
      name: account.name || null,
      club: account.club || null,
      team: account.team || null,
      saved: !!account.passToken,
    });
    return;
  }
  if (command === 'tag-decode') {
    print(require('../utils/TagCodec').describeTag(positional[1] || options.tag));
    return;
  }
  if (command === 'room-code') {
    const codec = require('../utils/TeamCode');
    const room =
      options.code || positional[1]
        ? codec.decode(options.code || positional[1])
        : { hi: Number(options.high || 0), lo: Number(options.low) };
    const offset = Protocol.integer(options.offset || 0, 'offset', -0x7fffffff, 0x7fffffff);
    const lo = room.lo + offset;
    print({ hi: room.hi, lo, code: codec.encode(room.hi, lo), note: I18N.t('cli.roomCode.note') });
    return;
  }
  if (command === 'tag-encode') {
    const Tag = require('../utils/TagCodec');
    print({
      tag: options.encodedId
        ? Tag.encodedIdToTag(BigInt(options.encodedId))
        : Tag.logicLongToTag(Number(options.high), Number(options.low)),
    });
    return;
  }
  if (['regions', 'club-badges'].includes(command)) {
    print(Store.read(path.join(ROOT, command === 'regions' ? 'data/regions.json' : 'data/club-badges.json'), []));
    return;
  }
  if (command === 'modes') {
    let values = Store.read(path.join(ROOT, 'data/maps.json'), []);
    if (options.mode) values = values.filter((v) => v.mode.toLowerCase().includes(options.mode.toLowerCase()));
    print({ source: I18N.t('cli.modes.source'), note: I18N.t('cli.modes.note'), maps: values });
    return;
  }
  if (!Actions.commands.includes(command)) throw new Error(I18N.t('cli.error.unknownCommand', { command }));
  if (options.dryRun) {
    if (
      [
        'login',
        'create-account',
        'team-info',
        'club-members',
        'club-online',
        'friends-online',
        'club-description',
        'club-trophies',
        'club-promote',
        'club-demote',
        'club-settings',
        'team-mode',
        'team-map',
        'invitations',
        'account-region',
        'club-stream',
        'club-requests',
        'club-answer',
      ].includes(command)
    ) {
      print({ command, options, network: false });
      return;
    }
    const wireCommand =
      command === 'brawl-tv' && !options.tag
        ? options.channel !== undefined
          ? 'brawl-tv-next'
          : 'brawl-tv-channels'
        : command;
    const packet = Protocol.encode(wireCommand === 'matchmake' ? 'ready' : wireCommand, options);
    print({ command, packetId: packet.id, payloadHex: packet.payload.toString('hex'), network: false });
    return;
  }
  const accountPath = path.resolve(ROOT, options.account || 'account.json');
  const existing = Store.read(accountPath, {});
  if (command === 'create-account' && (existing.hi || existing.lo)) throw new Error(I18N.t('cli.error.accountExists'));
  if (!existing.lo && !existing.hi && !options.name) throw new Error(I18N.t('cli.error.nameRequired'));
  if (existing.name && options.name && existing.name !== options.name) throw new Error(I18N.t('cli.error.nameLocked'));
  const client = new Client({
    root: ROOT,
    ...options,
    name: options.name,
    reconnect: !options.once && command === 'login',
  });
  global.Debugger = {
    info: (...args) => console.error(...args),
    warn: (...args) => console.error(...args),
    error: (...args) => console.error(...args),
  };
  client.on('warning', (error) => console.error(error.message));
  const stop = () => client.close();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    await client.connect();
    const result = await Actions.execute(client, command, options);
    print(result);
    if (result.confirmed === false) process.exitCode = 2;
    if (
      options.once ||
      result.stage === 'external-stream' ||
      !['login', 'spectate', 'brawl-tv', 'create-room', 'join-room', 'matchmake'].includes(command)
    )
      client.close();
  } catch (error) {
    client.close();
    throw error;
  }
}
module.exports = { main };
