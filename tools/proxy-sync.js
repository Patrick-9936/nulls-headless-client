#!/usr/bin/env node
'use strict';
// Автономный сборщик/обновлятор пула прокси.
//
//   node tools/proxy-sync.js [--root DIR] [--limit 400] [--candidates 3000]
//     [--parallel 40] [--timeout 8000] [--json] [--no-check]
//     [--prune] [--inbox FILE] [--list FILE|DIR ...] [--source-url URL]
//
// --no-check  — только накопить кандидатов (working-proxies.json не трогается)
// --prune     — перепроверить старый пул и объединить с новыми
// --json      — ровно один компактный JSON в stdout, логи в stderr
const path = require('node:path');

const Sources = require('../lib/ProxySources');
const Sync = require('../lib/ProxySync');

const HELP = [
  'proxy-sync — собрать и проверить пул прокси',
  '',
  '  node tools/proxy-sync.js [--root DIR] [--limit 400] [--candidates 3000]',
  '    [--parallel 40] [--timeout 8000] [--json] [--no-check]',
  '    [--prune] [--inbox FILE] [--list FILE|DIR ...] [--source-url URL]',
  '',
  '  --root DIR        каталог пула (по умолчанию ~/nulls)',
  '  --limit N         сколько рабочих прокси оставить (по умолчанию 400)',
  '  --candidates N    сколько кандидатов проверять (максимум 3000)',
  '  --parallel N      одновременных проверок (по умолчанию 40)',
  '  --timeout MS      таймаут одной проверки (по умолчанию 8000)',
  '  --no-check        только собрать кандидатов, пул не перезаписывать',
  '  --prune           перепроверить существующий пул и выкинуть мёртвые',
  '  --inbox FILE      файл с прокси (по умолчанию <root>/.runtime/proxy-inbox.txt)',
  '  --list FILE|DIR   свой список; каталог — все .txt/.list/.csv/.json внутри',
  '  --source-url URL  разовый источник по ссылке (можно повторять)',
  '  --json            один компактный JSON в stdout, логи в stderr',
  '',
  'Конфиг: <root>/.runtime/proxy-sources.json — массив',
  '  {name, protocol, url, allowPrivate?, auth?, enabled?}',
  'или локальная ферма: {name, protocol:"socks5", host:"127.0.0.1", ports:"30000-30799", allowPrivate:true}',
].join('\n');

function parseArgs(argv) {
  const options = { list: [], sourceUrl: [], json: false, noCheck: false, prune: false, help: false };
  const numbers = new Set(['limit', 'candidates', 'parallel', 'timeout', 'budget-ms', 'source-timeout', 'max-local']);
  const keys = {
    root: 'root',
    limit: 'limit',
    candidates: 'candidates',
    parallel: 'parallel',
    timeout: 'timeout',
    'budget-ms': 'budgetMs',
    'source-timeout': 'sourceTimeout',
    'max-local': 'maxLocal',
    inbox: 'inbox',
    'source-url': 'sourceUrl',
    list: 'list',
  };
  for (let index = 0; index < argv.length; index++) {
    const item = argv[index];
    if (!item.startsWith('--')) throw new Error(`Лишний аргумент: ${item}`);
    const [raw, ...inline] = item.slice(2).split('=');
    const inlineValue = inline.length ? inline.join('=') : undefined;
    const value = () => {
      if (inlineValue !== undefined) return inlineValue;
      const next = argv[++index];
      if (next === undefined || next.startsWith('--')) throw new Error(`Для --${raw} нужно значение`);
      return next;
    };
    const bool = (fallback = true) =>
      inlineValue === undefined ? fallback : !['false', '0', 'no', 'off'].includes(inlineValue.toLowerCase());
    if (raw === 'json') options.json = bool();
    else if (raw === 'no-check') options.noCheck = bool();
    else if (raw === 'prune') options.prune = bool();
    else if (raw === 'help' || raw === 'h') options.help = true;
    else if (numbers.has(raw)) {
      const parsed = Number(value());
      if (!Number.isFinite(parsed)) throw new Error(`--${raw}: нужно число`);
      options[keys[raw]] = parsed;
    } else if (raw === 'list') options.list.push(path.resolve(value()));
    else if (raw === 'source-url') options.sourceUrl.push(value());
    else if (raw === 'inbox') options.inbox = value();
    else if (raw === 'root') options.root = value();
    else throw new Error(`Неизвестный флаг --${raw}`);
  }
  return options;
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
    return Promise.resolve();
  }
  if (options.help) {
    process.stdout.write(HELP + '\n');
    return Promise.resolve();
  }

  const report = (payload) => {
    if (options.json) process.stdout.write(JSON.stringify(payload) + '\n');
  };
  const log = (scope, ...rest) => {
    const line = `${new Date().toISOString()} [${scope}] ${rest.join(' ')}\n`;
    (options.json ? process.stderr : process.stdout).write(line);
  };

  return (async () => {
    const startedAt = Date.now();
    const root = Sync.poolRoot(options.root);
    const limit = clamp(options.limit, 1, Sync.MAX_VALID, 400);
    const candidatesMax = clamp(options.candidates, 1, Sync.MAX_CANDIDATES, Sync.MAX_CANDIDATES);
    const parallel = clamp(options.parallel, 1, 200, 40);
    const timeout = clamp(options.timeout, 1000, 60000, 8000);
    const budgetMs = clamp(options.budgetMs, 10000, 60 * 60 * 1000, Sync.BUDGET_MS);

    log('sync', `root ${root}, кандидатов до ${candidatesMax}, цель ${limit}`);

    const gathered = await Sync.gather({
      root,
      candidates: candidatesMax,
      list: options.list,
      inbox: options.inbox,
      sourceUrl: options.sourceUrl,
      sourceTimeout: options.sourceTimeout,
      maxLocal: options.maxLocal,
    });
    for (const entry of gathered.stats.values())
      log('source', `${entry.name}: ${entry.candidates}${entry.error ? ` (${entry.error})` : ''}`);
    log('sync', `кандидатов собрано: ${gathered.candidates.length}`);

    let candidates = gathered.candidates;
    const origins = new Map(gathered.origins);
    if (options.prune) {
      const pool = Sync.readPool(root);
      // Старый пул идёт первым: это уже доказанные прокси, их перепроверяем
      // даже если --candidates не хватает на весь новый улов.
      const existing = pool.list;
      const existingSet = new Set(existing);
      for (const url of existing) if (!origins.has(url)) origins.set(url, 'pool:previous');
      gathered.stats.set('pool:previous', {
        name: 'pool:previous',
        protocol: 'mixed',
        candidates: existing.length,
        picked: existing.length,
        valid: 0,
        error: null,
      });
      candidates = [...existing, ...candidates.filter((url) => !existingSet.has(url))].slice(0, Sync.MAX_CANDIDATES);
      log('sync', `--prune: старый пул ${existing.length}, всего к проверке ${candidates.length}`);
    }

    if (options.noCheck) {
      const file = Sync.writeCandidates(root, {
        candidates,
        stats: Sync.mergeStats(gathered.stats, origins, []),
      });
      log('sync', `записано кандидатов: ${candidates.length} -> ${file}`);
      report({
        ok: true,
        checked: 0,
        valid: 0,
        added: candidates.length,
        sources: gathered.stats.size,
        elapsed: Date.now() - startedAt,
        file,
      });
      return;
    }

    if (!candidates.length) {
      const file = Sync.writePool(root, { proxies: [], checked: 0, stats: Sync.mergeStats(gathered.stats, origins, []) });
      log('sync', `кандидатов нет, пул пуст -> ${file}`);
      report({
        ok: true,
        checked: 0,
        valid: 0,
        added: 0,
        sources: gathered.stats.size,
        elapsed: Date.now() - startedAt,
        file,
      });
      return;
    }

    const result = await Sync.verify({
      candidates,
      limit,
      parallel,
      timeout,
      budgetMs,
      onProgress: ({ checked, valid, total }) =>
        log('check', `проверено ${checked}/${total}, рабочих ${valid}`),
    });
    const stats = Sync.mergeStats(gathered.stats, origins, result.valid);
    const file = Sync.writePool(root, { proxies: result.valid, checked: result.checked, stats });
    log('sync', `готово: ${result.valid.length} рабочих из ${result.checked} за ${Math.round(result.elapsed / 1000)} с`);
    if (result.budgetExceeded) log('sync', 'бюджет времени исчерпан, проверена часть кандидатов');
    report({
      ok: true,
      checked: result.checked,
      valid: result.valid.length,
      added: result.valid.length,
      sources: gathered.stats.size,
      elapsed: Date.now() - startedAt,
      file,
    });
  })().catch((error) => {
    log('error', error.message);
    report({
      ok: false,
      checked: 0,
      valid: 0,
      added: 0,
      sources: 0,
      elapsed: 0,
      file: null,
      error: error.message,
    });
    process.exitCode = 1;
  });
}

function clamp(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

if (require.main === module) {
  main();
}
module.exports = { parseArgs };