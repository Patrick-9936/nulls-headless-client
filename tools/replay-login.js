#!/usr/bin/env node
'use strict';
// Replay the exact ClientHello+Login bytes captured from a real, successful
// login (tools/fixtures/pcap-hello-login.bin) to the live server, and print
// whatever the server sends back — by frame TYPE, which is plaintext in the
// 7-byte header [u16 type][u24 len][u16 ver], so we can read it without any
// crypto.
//
// Purpose: a ground-truth check. If the server answers with 20100 ServerHello
// and especially 20104 LoginOk (or anything other than an immediate silent
// drop), the captured envelope is still accepted — proving the transport and
// envelope are fine and only our *generation* of the login crypto is wrong.
// If the replay is ALSO silently dropped, the server rejects even the real
// bytes (replay protection / stale session), which is itself informative.
//
// Usage:
//   node tools/replay-login.js                       # host/port from config.json
//   node tools/replay-login.js --host 62.233.36.73 --port 9339
//   node tools/replay-login.js --file tools/fixtures/pcap-full-burst.bin
//   node tools/replay-login.js --timeout 8000

const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) args[a.slice(2)] = process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : true;
}

const ROOT = path.resolve(__dirname, '..');
let cfg = {};
try {
  cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
} catch {}

const host = args.host || cfg.host || '62.233.36.73';
const port = Number(args.port || cfg.port || 9339);
const timeout = Number(args.timeout || 8000);
const file = args.file ? path.resolve(args.file) : path.join(__dirname, 'fixtures', 'pcap-hello-login.bin');

const payload = fs.readFileSync(file);
console.log(`replay -> ${host}:${port}  bytes=${payload.length}  file=${path.relative(ROOT, file)}  timeout=${timeout}ms`);

// parse the frames we are about to send, for the log
function listFrames(buf, label) {
  let i = 0;
  const out = [];
  while (i + 7 <= buf.length) {
    const t = buf.readUInt16BE(i);
    const ln = buf.readUIntBE(i + 2, 3);
    const v = buf.readUInt16BE(i + 5);
    if (ln > buf.length - (i + 7)) break;
    out.push(`${t}(${ln})`);
    i += 7 + ln;
  }
  console.log(`  ${label}: ${out.join(' ')}`);
}
listFrames(payload, 'sending');

const sock = new net.Socket();
let recv = Buffer.alloc(0);
let got = [];
const done = (why) => {
  try {
    sock.destroy();
  } catch {}
  console.log(`\nresult: ${why}`);
  console.log(`server frames received: ${got.length ? got.join(' ') : '(none)'}`);
  const ok = got.some((g) => g.startsWith('20104'));
  const hello = got.some((g) => g.startsWith('20100'));
  const failed = got.some((g) => g.startsWith('20103'));
  if (ok) console.log('>>> REPLAY ACCEPTED: server sent LoginOk (20104). The captured envelope is valid; only our crypto generation differs.');
  else if (failed) console.log('>>> server sent LoginFailed (20103) — envelope parsed, rejected by content/version. Still means the crypto envelope is accepted.');
  else if (hello) console.log('>>> server sent ServerHello (20100) then nothing/closed — handshake ok, login not accepted as replay.');
  else console.log('>>> no server frames — silent drop (same symptom as our generated login).');
  process.exit(ok || failed ? 0 : 1);
};

function drain() {
  while (recv.length >= 7) {
    const t = recv.readUInt16BE(0);
    const ln = recv.readUIntBE(2, 3);
    if (recv.length < 7 + ln) break;
    got.push(`${t}(${ln})`);
    recv = recv.subarray(7 + ln);
  }
}

const timer = setTimeout(() => done('timeout'), timeout);
sock.setTimeout(timeout + 2000);
sock.on('connect', () => {
  console.log('  connected, sending captured bytes...');
  sock.write(payload);
});
sock.on('data', (b) => {
  recv = Buffer.concat([recv, b]);
  drain();
});
sock.on('timeout', () => done('socket timeout'));
sock.on('error', (e) => done(`error ${e.code || e.message}`));
sock.on('close', () => {
  clearTimeout(timer);
  done('closed');
});
sock.connect(port, host);
