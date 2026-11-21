#!/usr/bin/env node
const path = require('node:path');
const { parse } = require('../lib/Args');
const Accounts = require('../lib/Accounts');

const ROOT = path.resolve(__dirname, '..');
// lib/Args.js не знает про эти флаги и без значения упал бы; подставляем явное true.
const FLAGS = new Set(['json', 'registered', 'dry-run', 'all']);

function parseArgs(argv) {
  return parse(argv.map((item) => (FLAGS.has(item.slice(2)) ? `${item}=true` : item)));
}

function formatTable(entries) {
  const headers = ['ИНДЕКС', 'ТЕГ', 'НИК', 'ТОКЕН', 'КЛУБ', 'ФАЙЛ'];
  const rows = entries.map((entry) => [
    entry.index === null ? '-' : String(entry.index),
    entry.tag || '-',
    entry.name || '-',
    entry.error ? 'БИТЫЙ' : entry.hasToken ? 'да' : 'нет',
    entry.club || '-',
    entry.file,
  ]);
  const widths = headers.map((header, i) => Math.max(header.length, ...rows.map((row) => row[i].length)));
  const line = (row) =>
    row
      .map((cell, i) => cell.padEnd(widths[i]))
      .join('  ')
      .trimEnd();
  return [line(headers), line(widths.map((width) => '-'.repeat(width))), ...rows.map(line)].join('\n');
}

function main() {
  const { options, positional } = parseArgs(process.argv.slice(2));
  const command = positional[0] || 'list';
  const json = !!options.json;
  if (command === 'list') {
    const registry = Accounts.read(ROOT);
    let entries = registry.accounts;
    if (options.registered) entries = entries.filter((entry) => entry.hasToken && (entry.hi || entry.lo));
    const limit = Number(options.limit ?? 0);
    if (Number.isInteger(limit) && limit > 0) entries = entries.slice(0, limit);
    if (json)
      console.log(
        JSON.stringify({ version: registry.version, updatedAt: registry.updatedAt, accounts: entries }, null, 2),
      );
    else if (!entries.length) console.log('Аккаунтов нет: accounts/ пуст или отсутствует');
    else console.log(formatTable(entries));
    return;
  }
  if (command === 'show') {
    const entry = Accounts.find(ROOT, positional[1]);
    if (!entry) {
      console.error('Аккаунт не найден; укажите индекс, тег или точный ник');
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify({ ...entry, path: path.join(Accounts.accountsDir(ROOT), entry.file) }, null, 2));
    return;
  }
  if (command === 'refresh') {
    const registry = Accounts.refresh(ROOT);
    console.log(
      JSON.stringify(
        { updatedAt: registry.updatedAt, accounts: registry.accounts.length, path: Accounts.registryPath(ROOT) },
        null,
        2,
      ),
    );
    return;
  }
  if (command === 'prune') {
    const report = Accounts.prune(ROOT, { dryRun: !!options.dryRun });
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  if (command === 'stats') {
    console.log(JSON.stringify(Accounts.stats(ROOT), null, 2));
    return;
  }
  if (command === 'cleanup') {
    const report = Accounts.cleanup(ROOT);
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  throw new Error('accounts: list|show|refresh|prune|stats|cleanup');
}
try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
