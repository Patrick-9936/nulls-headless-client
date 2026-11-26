#!/usr/bin/env node
'use strict';
// Login probe — the empirical oracle for the v70 10101 blocker.
//
// It drives the real handshake (ClientHello -> ServerHello -> Login) through
// the production Messaging path — same crypto (NullsCrypto), same ClientHello
// and Login encoders — then classifies what the server does with the Login
// (10101) frame:
//
//   OK      server sent LoginOk               -> login accepted
//   FAILED  server sent LoginFailed(code)      -> login parsed but rejected
//   REPLY   server sent some other encrypted frame after Login
//   SILENT  server closed the socket after Login with no reply (the v70 symptom)
//   NOHELLO server never sent ServerHello (blocked before the login stage)
//   TIMEOUT ServerHello seen, Login sent, nothing back within --timeout
//   CONNFAIL could not reach host:port (no raw TCP egress here — run it where
//            the game server is reachable)
//
// Because it reuses Messaging, a result here is exactly what `node Program.js
// login` would get. The point is to sweep the two unverified v70 choices —
// crypto plaintext layout (native | hello) and login body values
// (native70 | legacy69) — plus the unrecovered +0x13c connection value, and
// see which combination, if any, stops the server from silently dropping 10101.
//
// Usage:
//   node tools/login-probe.js                         # one run, config defaults
//   node tools/login-probe.js --account accounts/bot-1.json
//   node tools/login-probe.js --layout hello --body legacy69 --conn 1448
//   node tools/login-probe.js --sweep                 # layout x body matrix
//   node tools/login-probe.js --sweep --conn 1448,0,1,70,877 --account accounts/bot-1.json
//   node tools/login-probe.js --sweep --json          # machine-readable
//
// Flags:
//   --account FILE   account JSON (default: a fresh registration, hi/lo = 0)
//   --host H --port P overrides for config.host / config.port
//   --layout L       native | hello                 (default: config.loginLayout)
//   --body B         native70 | legacy69            (default: config.loginBodyProfile)
//   --conn N[,N...]  +0x13c connection value(s) to try (default: config value)
//   --timeout MS     wait after Login before giving up (default 6000)
//   --sweep          run every layout x body (x conn) combination
//   --json           print JSON instead of a table
//   --verbose        print the wire log from Messaging

const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const Messaging = require('../Messaging/Messaging');
const Queue = require('../DataStream/Queue');
const Store = require('../lib/Store');
const License = require('../utils/NullsLicense');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else {
        out[key] = next;
        i++;
      }
    } else out._.push(a);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const verbose = !!args.verbose;
global.Debugger = verbose
  ? {
      info: (...a) => console.error('  [i]', ...a),
      warn: (...a) => console.error('  [w]', ...a),
      error: (...a) => console.error('  [e]', ...a),
    }
  : { info() {}, warn() {}, error() {} };

const baseConfig = { ...Store.read(path.join(ROOT, 'config.json')), clientLicensePath: 'client-license.bin' };

function loadAccount(file) {
  const a = file ? Store.read(path.resolve(file), { hi: 0, lo: 0 }) : { hi: 0, lo: 0 };
  a.deviceId ||= crypto.randomBytes(16).toString('hex');
  a.openDeviceId ||= crypto.randomBytes(16).toString('hex');
  a.idForVendor ||= a.deviceId;
  a.androidId ||= baseConfig.androidId || crypto.randomBytes(8).toString('hex');
  return a;
}

function runOnce(overrides, account, timeout) {
  return new Promise((resolve) => {
    const config = { ...baseConfig, ...overrides };
    try {
      License.apply(config, ROOT);
    } catch (e) {
      global.Debugger.error(`license apply: ${e.message}`);
    }
    const socket = new net.Socket();
    const queue = new Queue();
    const start = Date.now();
    let settled = false;
    const result = {
      layout: config.loginLayout === 'hello' ? 'hello' : 'native',
      body: ['libwire', 'legacy69'].includes(config.loginBodyProfile) ? config.loginBodyProfile : 'native70',
      conn: config.loginConnectionValue ?? 1448,
      b2b: config.b2b ? `${config.b2b.nonce || '-'}/${config.b2b.keyKdf}/${config.b2b.macInput}/${config.b2b.macKey}` : null,
      gotHello: false,
      replyType: null,
      code: null,
      outcome: null,
      ms: null,
      error: null,
    };
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      result.outcome = outcome;
      result.ms = Date.now() - start;
      if (timer) clearTimeout(timer);
      try {
        socket.destroy();
      } catch {}
      resolve(result);
    };

    const messaging = new Messaging(socket, queue, {
      config,
      account,
      action: { mode: 'login', once: false },
      root: ROOT,
      reconnect: () => {},
    });
    messaging.saveAccount = () => {};
    messaging.saveConfig = () => {};
    messaging.onPacket = (type, payload) => {
      const p = config.packetIds;
      if (type === p.serverHello) {
        result.gotHello = true;
        return;
      }
      if (type === p.loginFailed) {
        result.replyType = type;
        result.code = payload.length >= 4 ? payload.readInt32BE(0) : null;
        return finish('FAILED');
      }
      const okIds = [p.loginOk, ...(p.loginOkCandidates || [])];
      if (okIds.includes(type)) {
        result.replyType = type;
        return finish('OK');
      }
      result.replyType = type;
      return finish('REPLY');
    };

    // Start the clock when the Login frame actually goes out. Sealing with the
    // v70 engine shells out to Python+Unicorn (~55 s), and execFileSync blocks
    // the event loop, so a timer armed at connect time would fire the moment
    // the seal returns — before the server has had any chance to answer.
    let timer = null;
    const arm = (ms) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => finish(result.gotHello ? 'TIMEOUT' : 'NOHELLO'), ms);
    };
    arm(timeout);
    // Watch the Login frame at the Messaging level: send() seals (a ~55 s
    // blocking Python call with the v70 engine) and only then writes, so this
    // is where "the login actually left" can be timed reliably.
    const rawEncrypt = messaging.crypto.encrypt.bind(messaging.crypto);
    messaging.crypto.encrypt = (type, payload) => {
      const out = rawEncrypt(type, payload);
      if (type === config.packetIds.login) result.loginLen = out.length;
      return out;
    };
    const rawSend = messaging.send.bind(messaging);
    messaging.send = (type, payload, version, onFlushed) => {
      const ret = rawSend(type, payload, version, onFlushed);
      if (!result.loginSentMs && type === config.packetIds.login) {
        result.loginSentMs = Date.now();

        arm(timeout);
      }
      return ret;
    };
    socket.on('connect', () => {
      try {
        messaging.sendPepperAuthentication();
      } catch (e) {
        result.error = e.message;
        finish('ERROR');
      }
    });
    // Raw-wire frame tap: the 7-byte frame header (type u16, len u24, version
    // u16) is plaintext, so we can classify every inbound frame — including an
    // encrypted LoginFailed/LoginOk whose payload we cannot decrypt yet.
    result.frames = result.frames || [];
    let rawBuf = Buffer.alloc(0);
    const tap = (bytes) => {
      rawBuf = Buffer.concat([rawBuf, bytes]);
      while (rawBuf.length >= 7) {
        const type = rawBuf.readUInt16BE(0);
        const len = rawBuf.readUIntBE(2, 3);
        if (rawBuf.length < 7 + len) break;
        result.frames.push({ type, len });
        if (!result.firstReplyAfterHello && result.gotHello && type !== config.packetIds.serverHello)
          result.firstReplyAfterHello = type;
        rawBuf = rawBuf.subarray(7 + len);
      }
    };
    socket.on('data', (bytes) => {
      try {
        tap(bytes);
      } catch {}
      queue.add(bytes);
      try {
        while (messaging.pendingJob()) messaging.update();
      } catch (e) {
        global.Debugger.error(`pump: ${e.message}`);
      }
    });
    socket.on('timeout', () => finish(result.gotHello ? 'TIMEOUT' : 'NOHELLO'));
    socket.on('error', (e) => {
      result.error = e.code || e.message;
      finish(result.gotHello ? 'SILENT' : 'CONNFAIL');
    });
    socket.on('close', () => finish(result.gotHello ? 'SILENT' : result.outcome || 'NOHELLO'));
    socket.connect(config.port, config.host);
  });
}

function overridesFrom(extra) {
  const o = {};
  if (args.host) o.host = args.host;
  if (args.port) o.port = Number(args.port);
  if (args.layout) o.loginLayout = args.layout;
  if (args.body) o.loginBodyProfile = args.body;
  if (args.plain) o.v70Plaintext = args.plain;
  return { ...o, ...extra };
}

(async () => {
  const account = loadAccount(typeof args.account === 'string' ? args.account : null);
  const timeout = Number(args.timeout) || 6000;
  const conns =
    typeof args.conn === 'string'
      ? args.conn
          .split(',')
          .map((s) => Number(s.trim()))
          .filter((n) => Number.isFinite(n))
      : [undefined];

  let runs;
  if (args.b2b) {
    // Sweep the v70 "blake2b box" reconstruction (cryptoMode nulls-blake2b).
    // Tries every keyKdf x counter x macInput x macKey combination and reports
    // which, if any, stops the server silently dropping the 10101.
    // The replay test proved the login depends on the ServerHello nonce, so
    // sweep the nonce source first. counter fixed to 'nonce_add' (the observed
    // 24-byte block form) to keep this pass ~72 runs.
    const nonce = ['server', 'blake_server_cpk_spk', 'blake_cpk_spk_server', 'blake_cpk_spk'];
    const keyKdf = ['blake2b64', 'shared_dup', 'shared_zero'];
    const macInput = ['nonce_ct', 'key_nonce_ct', 'ct'];
    const macKey = ['keyed', 'unkeyed'];
    runs = [];
    for (const nn of nonce)
      for (const kk of keyKdf)
        for (const mi of macInput)
          for (const mk of macKey)
            runs.push(overridesFrom({ cryptoMode: 'nulls-blake2b', b2b: { nonce: nn, keyKdf: kk, counter: 'nonce_add', macInput: mi, macKey: mk } }));
  } else if (args.sweep) {
    const layouts = args.layout ? [args.layout] : ['native', 'hello'];
    const bodies = args.body ? [args.body] : ['libwire', 'native70', 'legacy69'];
    runs = [];
    for (const loginLayout of layouts)
      for (const loginBodyProfile of bodies)
        for (const loginConnectionValue of conns)
          runs.push(overridesFrom({ loginLayout, loginBodyProfile, ...(loginConnectionValue !== undefined ? { loginConnectionValue } : {}) }));
  } else {
    runs = [overridesFrom(conns[0] !== undefined ? { loginConnectionValue: conns[0] } : {})];
  }

  const host = args.host || baseConfig.host;
  const port = Number(args.port) || baseConfig.port;
  if (!args.json) {
    console.log(`probe -> ${host}:${port}  account=${account.hi || account.lo ? `${account.hi}/${account.lo}` : 'fresh (registration)'}  timeout=${timeout}ms`);
    if (args.b2b) {
      console.log('nonce/keyKdf/macInput/macKey                     outcome   reply   code    ms');
      console.log('------------------------------------------------ --------- ------- ------- ------');
    } else {
      console.log('layout   body       conn        outcome   reply   code    ms');
      console.log('-------- ---------- ----------- --------- ------- ------- ------');
    }
  }
  const results = [];
  for (const ov of runs) {
    const r = await runOnce(ov, account, timeout);
    results.push(r);
    if (!args.json) {
      const left = args.b2b ? (r.b2b || '').padEnd(48) : [r.layout.padEnd(8), r.body.padEnd(10), String(r.conn).padEnd(11)].join(' ');
      const framesTxt = r.frames && r.frames.length ? `  frames=[${r.frames.map((f) => `${f.type}:${f.len}`).join(' ')}]` : '';
      const sentTxt = r.loginLen ? `  login=${r.loginLen}B` : '';
      console.log(
        [left, r.outcome.padEnd(9), String(r.replyType ?? '').padEnd(7), String(r.code ?? '').padEnd(7), String(r.ms)].join(' ') +
          (r.error ? `   (${r.error})` : '') +
          framesTxt +
          sentTxt,
      );
    }
  }
  if (args.json) console.log(JSON.stringify(results, null, 2));

  const win = results.find((r) => r.outcome === 'OK');
  const progress = results.find((r) => r.outcome === 'FAILED' || r.outcome === 'REPLY');
  // A reply frame after ServerHello (even one we cannot decrypt) means the
  // server accepted the login envelope's crypto and parsed the body — the
  // decisive signal that the v70 crypto is now correct.
  const replied = results.find((r) => r.firstReplyAfterHello);
  if (!args.json) {
    console.log('');
    if (win) console.log(`ACCEPTED: layout=${win.layout} body=${win.body} conn=${win.conn} -> LoginOk. Put these in config.json.`);
    else if (progress)
      console.log(
        `PROGRESS: layout=${progress.layout} body=${progress.body} conn=${progress.conn} got a reply (type ${progress.replyType}, code ${progress.code}) instead of a silent drop — the envelope decrypts and the body parses. Chase the code from here.`,
      );
    else if (replied)
      console.log(
        `CRYPTO OK: the server sent a reply frame (type ${replied.firstReplyAfterHello}) after Login instead of silently dropping — the v70 box is accepted. ` +
          `If it was LoginFailed (20103), read its code to fix the body; if 20104, it is LoginOk.`,
      );
    else console.log('All combinations were silently dropped (SILENT) or blocked before login. If using cryptoMode=v70-engine, the crypto is correct, so the body content is the remaining issue; otherwise the crypto is still wrong.');
  }
  process.exitCode = win ? 0 : 1;
})();
