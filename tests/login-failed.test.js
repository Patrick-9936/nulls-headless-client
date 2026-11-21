const test = require('node:test');
const assert = require('node:assert/strict');

const ByteStream = require('../DataStream/ByteStream');
const LoginFailed = require('../Messaging/Messages/Server/LoginFailedMessage');

function payload(errorCode, fingerprint = '', message = '') {
  const s = new ByteStream();
  s.writeInt(errorCode);
  s.writeOptionalString(fingerprint);
  s.writeOptionalString('');
  s.writeOptionalString('');
  s.writeOptionalString('');
  s.writeOptionalString(message);
  return s.getBytes();
}

function fakeMessaging(config = { major: 69, minor: 252, build: 0 }) {
  const calls = [];
  return {
    calls,
    config,
    crypto: { sessionKey: null },
    saveConfig() {},
    close(reason) { calls.push(['close', reason]); },
  };
}

test('error 8 carries an actionable hint about a stale build or license block', () => {
  const msg = new LoginFailed();
  msg.ByteStream.set(payload(8));
  msg.decode();
  const messaging = fakeMessaging();
  msg.process(messaging);

  assert.equal(msg.errorCode, 8);
  assert.match(msg.hint, /stale/);
  assert.match(msg.hint, /APK-UPDATE\.md/);
  assert.deepEqual(messaging.calls, [['close', 'LoginFailed']]);
});

test('server version from the fingerprint is compared with the client version', () => {
  const fingerprint = JSON.stringify({ sha: 'a'.repeat(40), version: '69.253.0' });
  const msg = new LoginFailed();
  msg.ByteStream.set(payload(8, fingerprint));
  msg.decode();
  const messaging = fakeMessaging();
  msg.process(messaging);

  assert.deepEqual(
    [messaging.config.major, messaging.config.minor, messaging.config.build],
    [69, 253, 0],
  );
  assert.equal(messaging.config.fingerprintHash, 'a'.repeat(40));
});

test('unknown error code still closes the session without a hint', () => {
  const msg = new LoginFailed();
  msg.ByteStream.set(payload(77));
  msg.decode();
  const messaging = fakeMessaging();
  msg.process(messaging);

  assert.equal(msg.hint, '');
  assert.deepEqual(messaging.calls, [['close', 'LoginFailed']]);
});
