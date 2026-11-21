const path = require('node:path');
const { parse } = require('./Args');
const Store = require('./Store');
const Protocol = require('./Protocol');
const Actions = require('./Actions');
const Client = require('./Client');
const I18N = require('./i18n');
const { AppError, codes, toJSON } = require('./Errors');
const ROOT = path.resolve(__dirname, '..');
const VERSION = require('../package.json').version;
const print = (value) => console.log(JSON.stringify(value, null, 2));
const configPath = () => path.join(ROOT, 'config.json');

// Глобальные флаги, которые Args.parse не знает и которые иначе съели бы следующий аргумент.
const GLOBAL_FLAGS = { json: 'json', quiet: 'quiet', 'no-color': 'noColor' };

// Вынимает --json/--quiet/--no-color из argv до parse. Поддерживает =false/=0/=no.
function splitGlobals(argv = []) {
  const flags = { json: false, quiet: false, noColor: false };
  const rest = [];
  for (const item of argv) {
    if (typeof item === 'string' && item.startsWith('--')) {
      const [raw, ...inline] = item.slice(2).split('=');
      const key = GLOBAL_FLAGS[raw];
      if (key) {
        const value = inline.length ? !['false', '0', 'no'].includes(inline.join('=')) : true;
        flags[key] = value;
        continue;
      }
    }
    rest.push(item);
  }
  return { flags, argv: rest };
}

// no-op Debugger и подавление предупреждений: --quiet молчит, --json не пишет в stdout.
function makeLogger({ json = false, quiet = false } = {}) {
  const silent = (...args) => {
    void args;
  };
  return {
    json,
    quiet,
    installDebugger(target = global) {
      // --quiet: полностью no-op, включая info (он печатал бы в stdout).
      // Обычный режим: диагностика в stderr, чтобы не ломать машинный вывод.
      target.Debugger = quiet
        ? { info: silent, warn: silent, error: silent }
        : {
            info: (...args) => console.error(...args),
            warn: (...args) => console.error(...args),
            error: (...args) => console.error(...args),
          };
    },
    warning(error) {
      if (quiet) return;
      console.error(error instanceof Error ? error.message : String(error));
    },
    // --json: один объект {ok:true,result}; иначе прежний pretty-JSON.
    result(value) {
      if (json) this.jsonLine({ ok: true, result: value });
      else print(value);
    },
    // Уже готовый JSON-объект (watch сам формирует { ok, result }).
    jsonLine(value) {
      process.stdout.write(JSON.stringify(value) + '\n');
    },
    text(value) {
      if (json) return;
      console.log(value);
    },
    // --json: один объект {ok:false,error:{message,code?,kind,retryable,details?}} в stderr.
    // Код возврата: 2 для ошибок аргументов (kind=input), иначе 1; error.exitCode важнее.
    failure(error) {
      if (!json) throw error;
      const safe = toJSON(error);
      const body = { ok: false, error: { message: error.message } };
      if (error.code) body.error.code = error.code;
      body.error.kind = error.kind || safe.kind;
      body.error.retryable = error.retryable === undefined ? safe.retryable : error.retryable === true;
      if (Object.keys(safe.details).length) body.error.details = safe.details;
      if (error.result !== undefined) body.result = error.result;
      process.stderr.write(JSON.stringify(body) + '\n');
      process.exitCode = error.exitCode || (body.error.kind === 'input' ? 2 : 1);
    },
  };
}

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

function sourceLabel(source) {
  return I18N.t(`cli.lang.source.${source}`);
}

function languageReport(info, config) {
  const language = info.language;
  return {
    language,
    name: I18N.label(language),
    mode: info.mode,
    modeLabel: I18N.t(`cli.lang.mode.${info.mode}`),
    source: info.source,
    sourceLabel: sourceLabel(info.source),
    configured: config && config.uiLanguage !== undefined ? config.uiLanguage : I18N.AUTO,
    message:
      info.mode === I18N.AUTO
        ? I18N.t('cli.lang.autoCurrent', { language: I18N.label(language) })
        : I18N.t('cli.lang.current', { language: I18N.label(language) }),
    supported: languageList(language),
  };
}

function unknownLanguage(requested) {
  return new AppError(
    codes.INVALID_ARGUMENT,
    I18N.t('cli.error.unknownLanguage', { language: requested, supported: I18N.SUPPORTED.join(', ') }),
    { details: { argument: 'lang', language: requested } },
  );
}

// Язык интерфейса: --lang -> config.uiLanguage -> env -> системная локаль -> ru.
// Возвращает { language, mode, source } для отчёта команды lang.
function bootLanguage(options, config, env = process.env) {
  if (options.lang !== undefined) {
    const mode = I18N.resolveMode(options.lang);
    if (mode === I18N.AUTO) {
      const info = I18N.detectInfo({ lang: I18N.AUTO, config, env });
      I18N.setLanguage(info.language);
      return info;
    }
    if (!mode) {
      I18N.setLanguage(I18N.detect({ config, env }));
      throw unknownLanguage(options.lang);
    }
    I18N.setLanguage(mode);
    return { language: mode, mode: 'fixed', source: 'lang' };
  }
  const info = I18N.detectInfo({ config, env });
  I18N.setLanguage(info.language);
  return info;
}

function helpReport() {
  const language = { code: I18N.getLanguage(), name: I18N.label(I18N.getLanguage()) };
  const lines = [
    I18N.t('cli.help.title', { version: VERSION }),
    '',
    I18N.t('cli.help.usage'),
    I18N.t('cli.help.commands', { commands: Actions.commands.join(', ') }),
    '',
    I18N.t('cli.help.utilities'),
    I18N.t('cli.help.lang', { language: `${language.code} (${language.name})` }),
    I18N.t('cli.help.fleet'),
    I18N.t('cli.help.fleetCommand'),
    I18N.t('cli.help.watch'),
    I18N.t('cli.help.docs'),
  ];
  return {
    version: VERSION,
    usage: I18N.t('cli.help.usage'),
    commands: Actions.commands.slice(),
    utilities: [
      'info',
      'account-info',
      'tag-decode',
      'tag-encode',
      'room-code',
      'update',
      'modes',
      'regions',
      'club-badges',
      'features',
      'lang',
      'watch',
    ],
    language,
    text: lines.join('\n'),
  };
}

// Флаг --json: результат — ровно один объект. Логи и предупреждения уходят в stderr.
async function run(argv, flags, logger) {
  const { options, positional } = parse(argv);
  const command = positional[0] || 'help';
  const config = readConfig();
  const boot = bootLanguage(options, config);
  flags.json = logger.json;
  if (command === 'help') {
    const report = helpReport();
    if (flags.json) logger.result(report);
    else logger.text(report.text);
    return;
  }
  if (command === 'watch') {
    // tools/watch.js подключается лениво: фикстурам без каталога tools он не мешает.
    const watch = require('../tools/watch');
    const write = (chunk) => process.stdout.write(chunk);
    await watch.run({ root: ROOT, options, flags, print: (value) => logger.jsonLine(value), write });
    return;
  }
  if (command === 'lang' || command === 'language') {
    const requested = positional[1];
    if (!requested) {
      const info = I18N.detectInfo({ lang: options.lang, config, env: process.env });
      logger.result(languageReport(info, config));
      return;
    }
    const mode = I18N.resolveMode(requested);
    if (mode === I18N.AUTO) {
      const saved = saveConfig({ uiLanguage: I18N.AUTO });
      const info = I18N.detectInfo({ config: saved, env: process.env });
      I18N.setLanguage(info.language);
      logger.result({
        ...languageReport(info, saved),
        saved: true,
        file: 'config.json',
        message: I18N.t('cli.lang.autoChanged', { language: I18N.label(info.language) }),
      });
      return;
    }
    if (!mode) throw unknownLanguage(requested);
    const saved = saveConfig({ uiLanguage: mode });
    I18N.setLanguage(mode);
    logger.result({
      ...languageReport({ language: mode, mode: 'fixed', source: 'config' }, saved),
      saved: true,
      file: 'config.json',
      message: I18N.t('cli.lang.changed', { language: I18N.label(mode) }),
    });
    return;
  }
  if (command === 'update') {
    await require('../utils/AutoUpdate').main(ROOT, argv.slice(1));
    return;
  }
  if (command === 'info') {
    const c = config;
    logger.result({
      version: VERSION,
      host: c.host,
      binary: c.appBinaryVersion,
      content: `${c.major}.${c.minor}.${c.build}`,
      cryptoMode: c.cryptoMode,
      language: I18N.getLanguage(),
      languageMode: boot.mode,
      languageSource: boot.source,
    });
    return;
  }
  if (command === 'features') {
    logger.result(Store.read(path.join(ROOT, 'docs/features.json'), { commands: Actions.commands }));
    return;
  }
  if (command === 'account-info') {
    const account = Store.read(path.resolve(ROOT, options.account || 'account.json'), {});
    logger.result({
      tag: account.lo ? require('../utils/TagCodec').logicLongToTag(account.hi, account.lo) : null,
      name: account.name || null,
      club: account.club || null,
      team: account.team || null,
      saved: !!account.passToken,
    });
    return;
  }
  if (command === 'tag-decode') {
    logger.result(require('../utils/TagCodec').describeTag(positional[1] || options.tag));
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
    logger.result({ hi: room.hi, lo, code: codec.encode(room.hi, lo), note: I18N.t('cli.roomCode.note') });
    return;
  }
  if (command === 'tag-encode') {
    const Tag = require('../utils/TagCodec');
    logger.result({
      tag: options.encodedId
        ? Tag.encodedIdToTag(BigInt(options.encodedId))
        : Tag.logicLongToTag(Number(options.high), Number(options.low)),
    });
    return;
  }
  if (['regions', 'club-badges'].includes(command)) {
    logger.result(
      Store.read(path.join(ROOT, command === 'regions' ? 'data/regions.json' : 'data/club-badges.json'), []),
    );
    return;
  }
  if (command === 'modes') {
    let values = Store.read(path.join(ROOT, 'data/maps.json'), []);
    if (options.mode) values = values.filter((v) => v.mode.toLowerCase().includes(options.mode.toLowerCase()));
    logger.result({ source: I18N.t('cli.modes.source'), note: I18N.t('cli.modes.note'), maps: values });
    return;
  }
  if (!Actions.commands.includes(command))
    throw new AppError(codes.INVALID_ARGUMENT, I18N.t('cli.error.unknownCommand', { command }), {
      details: { command },
    });
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
      logger.result({ command, options, network: false });
      return;
    }
    const wireCommand =
      command === 'brawl-tv' && !options.tag
        ? options.channel !== undefined
          ? 'brawl-tv-next'
          : 'brawl-tv-channels'
        : command;
    const packet = Protocol.encode(wireCommand === 'matchmake' ? 'ready' : wireCommand, options);
    logger.result({ command, packetId: packet.id, payloadHex: packet.payload.toString('hex'), network: false });
    return;
  }
  const accountPath = path.resolve(ROOT, options.account || 'account.json');
  const existing = Store.read(accountPath, {});
  if (command === 'create-account' && (existing.hi || existing.lo))
    throw new AppError(codes.STATE_ERROR, I18N.t('cli.error.accountExists'), {
      details: { file: accountPath, command },
    });
  if (!existing.lo && !existing.hi && !options.name)
    throw new AppError(codes.INVALID_ARGUMENT, I18N.t('cli.error.nameRequired'), {
      details: { argument: 'name', command },
    });
  if (existing.name && options.name && existing.name !== options.name)
    throw new AppError(codes.STATE_ERROR, I18N.t('cli.error.nameLocked'), {
      details: { argument: 'name', command },
    });
  // Debugger выставляется до конструктора Client: иначе Client подставит логгер в stdout.
  logger.installDebugger();
  const client = new Client({
    root: ROOT,
    ...options,
    name: options.name,
    reconnect: !options.once && command === 'login',
  });
  client.on('warning', (error) => logger.warning(error));
  const stop = () => client.close();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    await client.connect();
    const result = await Actions.execute(client, command, options);
    if (result && result.confirmed === false) {
      if (logger.json) {
        // Код 'unconfirmed' сохранён ради внешних скриптов (docs/COMMANDS.md); kind=server.
        const error = new AppError('unconfirmed', I18N.t('cli.json.unconfirmed'), {
          kind: 'server',
          details: { command },
        });
        error.result = result;
        error.exitCode = 2;
        logger.failure(error);
      } else {
        logger.result(result);
        process.exitCode = 2;
      }
    } else {
      logger.result(result);
    }
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

async function main(argv = process.argv.slice(2)) {
  const { flags, argv: rest } = splitGlobals(argv);
  const logger = makeLogger(flags);
  logger.installDebugger();
  try {
    await run(rest, flags, logger);
  } catch (error) {
    // Код возврата: 2 для ошибок аргументов, 1 для остальных. Program.js печатает текст и
    // сохраняет свой прежний код, поэтому здесь только фиксируется признак для --json.
    if (!logger.json) {
      process.exitCode = error instanceof AppError && error.kind === 'input' ? 2 : 1;
      throw error;
    }
    logger.failure(error);
  }
}
module.exports = { main, splitGlobals, makeLogger, helpReport };
