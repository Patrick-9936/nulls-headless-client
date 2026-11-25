#!/usr/bin/env node
'use strict';
// Transparent relay + frame logger for the Nulls handshake.
//
//   node tools/relay.js [--listen 9339] [--upstream brawl.server.dnull.xyz:9339] [--out capture.log]
//
// Point the phone's in-app proxy host at this machine (127.0.0.1 while running in
// Termux) and open the game. The relay forwards both directions unchanged, so the
// real client logs in normally, while every frame is written to the log in hex.
const fs = require('fs');
const net = require('net');
const path = require('path');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const LISTEN = Number(arg('listen', 9339));
const UP = arg('upstream', 'brawl.server.dnull.xyz:9339');
const OUT = arg('out', path.join(process.cwd(), 'capture.log'));
const [upHost, upPort] = [UP.slice(0, UP.lastIndexOf(':')), Number(UP.slice(UP.lastIndexOf(':') + 1))];

const logFd = fs.openSync(OUT, 'a');
const stamp = () => new Date().toISOString();

function log(line) {
  fs.writeSync(logFd, line + '\n');
}

// Split a byte stream into frames using the 7-byte header (id BE16 | len BE24 | ver BE16).
function makeParser(dir, tag) {
  let buf = Buffer.alloc(0);
  let n = 0;
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 7) {
      const id = buf.readUInt16BE(0);
      const len = buf.readUIntBE(2, 3);
      const ver = buf.readUInt16BE(5);
      if (buf.length < len + 7) {
        log(`${stamp()} ${dir} ${tag} partial id=${id} len=${len} have=${buf.length - 7}`);
        return;
      }
      const body = buf.subarray(7, 7 + len);
      buf = buf.subarray(7 + len);
      n++;
      log(`${stamp()} ${dir} ${tag} #${n} id=${id} ver=${ver} len=${len}`);
      log(`    ${body.toString('hex')}`);
      if (dir === 'C>S' && (id === 10101 || id === 10100)) {
        log(`    >> ${id} offset-in-body: prefix32=${body.subarray(0, 32).toString('hex')}`);
      }
    }
  };
}

const server = net.createServer((cs) => {
  const peer = `${cs.remoteAddress}:${cs.remotePort}`;
  log(`${stamp()} ---- connection from ${peer}`);
  const us = net.connect(upPort, upHost);
  const csParse = makeParser('C>S', 'client');
  const usParse = makeParser('S>C', 'server');

  cs.on('data', (c) => {
    try { us.write(c); } catch {}
    csParse(c);
  });
  us.on('data', (c) => {
    try { cs.write(c); } catch {}
    usParse(c);
  });

  const close = (why) => {
    log(`${stamp()} ---- closed (${why})`);
    try { cs.destroy(); } catch {}
    try { us.destroy(); } catch {}
  };
  cs.on('error', () => close('client-error'));
  us.on('error', (e) => close('upstream-' + e.code));
  cs.on('close', () => close('client-close'));
  us.on('close', () => close('upstream-close'));
  us.setNoDelay(true);
  cs.setNoDelay(true);
});

server.listen(LISTEN, '0.0.0.0', () => {
  fs.writeSync(1, `relay listening on 0.0.0.0:${LISTEN} -> ${upHost}:${upPort}\nlog: ${OUT}\n`);
});
