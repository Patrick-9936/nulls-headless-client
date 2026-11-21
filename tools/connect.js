#!/usr/bin/env node
// tools/connect.js — CLI для Nulls Connect (PIN по e-mail, bind, links, game token).
//
// Примеры:
//   node tools/connect.js pin --email user@example.com --locale ru --game laser
//   node tools/connect.js confirm --email user@example.com --pin 1234
//   node tools/connect.js bind --account accounts/bot-1.json
//   node tools/connect.js bind --bind-token <jwt> --token <bearer>
//   node tools/connect.js links
//   node tools/connect.js token --player-id 123456 --show-token
//   node tools/connect.js status
//   node tools/connect.js logout
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { parse } = require('../lib/Args');
const Connect = require('../lib/Connect');

const ROOT = path.resolve(__dirname, '..');
// --json: одна строка {"ok":true,"result":…}, как в остальном CLI.
let jsonMode = false;
const print = (value) =>
  console.log(jsonMode ? JSON.stringify({ ok: true, result: value }) : JSON.stringify(value, null, 2));
const SECRET_KEYS = /^(token|access_token|refresh_token|bearer|bind_token|bindToken|password|pin)$/i;

class UsageError extends Error {}

function help() {
  console.log(
    [
      'Nulls Connect CLI',
      '',
      'node tools/connect.js <команда> [параметры]',
      '',
      'Команды:',
      '  pin      --email a@b.c [--locale ru] [--game laser]',
      '  confirm  --email a@b.c --pin 1234 [--locale ru] [--game laser]',
      '  bind     --bind-token <jwt> [--token <bearer>] | --account accounts/bot-1.json',
      '  unbind   --bind-token <jwt> [--token <bearer>] | --account accounts/bot-1.json',
      '  links    [--token <bearer>] [--game laser]',
      '  token    --player-id <id> [--token <bearer>] [--show-token]',
      '  status   (локальное состояние, без сети)',
      '  logout   (удалить .runtime/connect.json)',
      '',
      'Глобально: --json (одна строка {"ok":true,"result":…}), --json=false (pretty-JSON), --quiet.',
      '',
      'Токен хранится в .runtime/connect.json с правами 0600 и в выводе не печатается.',
      'Переменные окружения: NC_API_UPSTREAM, NC_PROFILES_UPSTREAM, NC_STATE_FILE.',
      '',
      'Примеры:',
      '  node tools/connect.js pin --email user@example.com',
      '  node tools/connect.js confirm --email user@example.com --pin 1234',
      '  node tools/connect.js bind --account accounts/bot-1.json',
      '  node tools/connect.js unbind --account accounts/bot-1.json',
      '  node tools/connect.js links',
      '  node tools/connect.js token --player-id 123456',
    ].join('\n'),
  );
}

function redact(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (depth > 6) return '[слишком глубоко]';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (typeof value !== 'object') return value;
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEYS.test(key) && typeof item === 'string') {
      output[key] = `[скрыто, ${item.length} символов]`;
    } else {
      output[key] = redact(item, depth + 1);
    }
  }
  return output;
}

function required(options, key, message) {
  if (!options[key]) throw new UsageError(message);
  return options[key];
}

function bindTokenFromAccount(file) {
  // Как в lib/CLI.js: путь ищется от корня клиента, затем от текущего каталога.
  const candidates = path.isAbsolute(file) ? [file] : [path.resolve(ROOT, file), path.resolve(process.cwd(), file)];
  const resolved = candidates.find((item) => fs.existsSync(item)) || candidates[0];
  let account;
  try {
    account = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch (error) {
    throw new UsageError(`Не читается аккаунт ${resolved}: ${error.message}`);
  }
  const raw = account?.bindToken;
  const token = typeof raw === 'string' ? raw : raw?.token;
  if (typeof token !== 'string' || !token) {
    throw new UsageError(`В аккаунте ${resolved} нет bindToken: сначала выполните login с этим аккаунтом`);
  }
  return token;
}

async function main() {
  const raw = process.argv.slice(2);
  if (!raw.length || raw.includes('--help') || raw.includes('-h')) {
    help();
    return;
  }
  // --show-token is a bare switch; --json/--quiet уже boolean в lib/Args.
  const argv = raw.map((item) => (item === '--show-token' ? '--show-token=1' : item));
  let options, positional;
  try {
    ({ options, positional } = parse(argv));
  } catch (error) {
    throw new UsageError(error.message);
  }
  jsonMode = options.json === true;
  const command = positional[0] || 'status';
  const showToken = ['1', 'true', 'yes'].includes(String(options.showToken || '').toLowerCase());

  if (command === 'pin') {
    const email = required(options, 'email', 'Нужен --email');
    const result = await Connect.requestPin(email, { locale: options.locale, game: options.game });
    print({ email: Connect.maskEmail(email), status: result.status, data: redact(result.data) });
    return;
  }

  if (command === 'confirm') {
    const email = required(options, 'email', 'Нужен --email');
    const pin = required(options, 'pin', 'Нужен --pin');
    const result = await Connect.confirmPin(email, pin, { locale: options.locale, game: options.game });
    const state = Connect.status();
    print({
      status: result.status,
      saved: state.hasToken,
      email: state.email,
      at: state.at,
      data: redact(result.data),
    });
    return;
  }

  if (command === 'bind') {
    const bindToken = options.bindToken || (options.account ? bindTokenFromAccount(options.account) : null);
    if (!bindToken) throw new UsageError('Нужен --bind-token <jwt> или --account с сохранённым bindToken');
    const result = await Connect.bind(bindToken, { token: options.token, game: options.game });
    print({ status: result.status, data: redact(result.data) });
    return;
  }

  if (command === 'unbind') {
    const bindToken = options.bindToken || (options.account ? bindTokenFromAccount(options.account) : null);
    if (!bindToken) throw new UsageError('Нужен --bind-token <jwt> или --account с сохранённым bindToken');
    const result = await Connect.unbind(bindToken, { token: options.token, game: options.game });
    print({ status: result.status, unbound: true, data: redact(result.data) });
    return;
  }

  if (command === 'links') {
    const result = await Connect.links({ token: options.token, game: options.game });
    print({ status: result.status, data: redact(result.data) });
    return;
  }

  if (command === 'token') {
    const playerId = required(options, 'playerId', 'Нужен --player-id');
    const result = await Connect.gameToken(playerId, { token: options.token, game: options.game });
    const data = result.data;
    const token = typeof data === 'string' ? data : data?.token || data?.game_token || null;
    if (showToken) {
      print({ status: result.status, playerId, token });
      return;
    }
    print({
      status: result.status,
      playerId,
      tokenPrefix: token ? `${String(token).slice(0, 6)}…` : null,
      tokenLength: token ? String(token).length : 0,
      note: token ? 'полный токен скрыт; используйте --show-token для вывода' : 'сервер не вернул поле token',
      data: token ? undefined : redact(data),
    });
    return;
  }

  if (command === 'status') {
    print(Connect.status());
    return;
  }

  if (command === 'logout') {
    print(Connect.logout());
    return;
  }

  throw new UsageError(`Неизвестная команда ${command}; см. --help`);
}

main().catch((error) => {
  const usage = error instanceof UsageError;
  console.error(usage ? error.message : `${error.code ? `${error.code}: ` : ''}${error.message}`);
  process.exitCode = usage ? 2 : 1;
});
