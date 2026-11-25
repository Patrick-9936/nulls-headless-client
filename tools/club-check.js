#!/usr/bin/env node
'use strict';
// Delivery proof: one account joins a club and talks, a second account joins the
// same club and reads its stream, then we report whether the text arrived.
const path = require('node:path');
const Client = require('../lib/Client');
const Actions = require('../lib/Actions');
const Store = require('../lib/Store');
const {parse} = require('../lib/Args');

const ROOT = path.resolve(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function open(index) {
  const account = Store.read(path.join(ROOT, 'accounts', `bot-${index}.json`), {});
  if (!account.passToken) throw new Error(`bot-${index}: нет аккаунта`);
  const client = new Client({root: ROOT, account: `accounts/bot-${index}.json`, name: account.name, reconnect: false, index});
  client.on('warning', () => {});
  await client.connect();
  return client;
}

async function main() {
  const {options} = parse(process.argv.slice(2));
  const tag = options.club;
  const text = options.text || 'test delivery';
  const a = Number(options.a ?? 1), b = Number(options.b ?? 2);
  if (!tag) throw new Error('--club #TAG');
  global.Debugger = {info: () => {}, warn: () => {}, error: () => {}};

  const speaker = await open(a);
  const listener = await open(b);
  try {
    await Actions.execute(speaker, 'join-club', {clubTag: tag, timeout: 25000});
    console.log(`[${a}] вошёл в ${tag}`);
    await Actions.execute(listener, 'join-club', {clubTag: tag, timeout: 25000});
    console.log(`[${b}] вошёл в ${tag}`);
    await sleep(800);
    await Actions.execute(speaker, 'club-chat', {text, timeout: 15000});
    console.log(`[${a}] отправил: ${JSON.stringify(text)}`);
    await sleep(1500);
    const stream = await Actions.execute(listener, 'club-stream', {timeout: 15000});
    const entries = stream.entries || [];
    const hit = entries.filter(entry => JSON.stringify(entry).includes(text));
    console.log(JSON.stringify({
      listener: b, entries: entries.length, matches: hit.length,
      delivered: hit.length > 0,
      sample: entries.slice(-3).map(entry => ({type: entry.type, text: entry.text, name: entry.display?.name}))
    }, null, 2));
  } finally {
    for (const client of [speaker, listener]) {
      try {await Actions.execute(client, 'leave-club', {timeout: 12000});} catch {}
      try {client.close();} catch {}
    }
  }
}

main().catch(error => {console.error(error.message); process.exitCode = 1;});