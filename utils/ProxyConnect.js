const fs = require('fs');
const { AppError, codes, isAppError } = require('../lib/Errors');

// Все ошибки прокси — PROXY_FAILED (kind network, retryable true: пул может
// переключиться на следующий прокси). Таймаут — отдельный код TIMEOUT.
// Исходные тексты сообщений сохранены: внешние скрипты и тесты их сравнивают.
function proxyFailure(message, details = {}) {
  return new AppError(codes.PROXY_FAILED, message, { kind: 'network', retryable: true, details });
}

function proxyTimeout(message, details = {}) {
  return new AppError(codes.TIMEOUT, message, { kind: 'timeout', retryable: true, details });
}

function normalizeProxyError(error, details = {}) {
  if (isAppError(error)) return error;
  const message = error && error.message ? error.message : String(error);
  return new AppError(codes.PROXY_FAILED, message, { kind: 'network', retryable: true, details, cause: error });
}

function parseProxy(value) {
  let url;
  try {
    url = new URL(typeof value === 'string' ? value : value.url);
  } catch (error) {
    throw proxyFailure('Invalid proxy URL', { field: 'url', cause: error.message });
  }
  if (!['socks5:', 'http:'].includes(url.protocol))
    throw proxyFailure('Proxy must use socks5:// or http://', { field: 'protocol' });
  const port = Number(url.port || (url.protocol === 'http:' ? 80 : 1080));
  const username =
    typeof value === 'object' && value.username !== undefined
      ? String(value.username)
      : decodeURIComponent(url.username);
  const password =
    typeof value === 'object' && value.password !== undefined
      ? String(value.password)
      : decodeURIComponent(url.password);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw proxyFailure('Invalid proxy port', { field: 'port', port });
  return { type: url.protocol.slice(0, -1), host: url.hostname.replace(/^\[|\]$/g, ''), port, username, password };
}

function loadProxy(file) {
  if (!file) return null;
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw normalizeProxyError(error, { file, operation: 'read' });
  }
  return parseProxy(data);
}

function loadPool(file) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw normalizeProxyError(error, { file, operation: 'read' });
  }
  const items = Array.isArray(data) ? data : data.proxies;
  if (!Array.isArray(items)) throw proxyFailure('Proxy pool must contain a proxies array', { file });
  return items.map(parseProxy);
}

async function tunnel(socket, host, port, proxy, command = 1, timeoutMs = 10000) {
  if (command === 3 && proxy.type !== 'socks5')
    throw proxyFailure('UDP requires a SOCKS5 proxy', { command, type: proxy.type });
  let bound = null;
  let buffer = Buffer.alloc(0),
    pending = null,
    failure = null;
  function fail(error) {
    failure = normalizeProxyError(error, { host, port });
    if (pending) {
      pending.reject(failure);
      pending = null;
    }
  }
  function drain() {
    if (!pending) return;
    let n;
    try {
      n = pending.size(buffer);
    } catch (e) {
      fail(e);
      return;
    }
    if (n === null) return;
    const p = pending;
    pending = null;
    const bytes = buffer.subarray(0, n);
    buffer = buffer.subarray(n);
    p.resolve(bytes);
  }
  const data = (bytes) => {
    buffer = Buffer.concat([buffer, bytes]);
    if (buffer.length > 65536) return fail(proxyFailure('Oversized proxy response', { host, port, limit: 65536 }));
    drain();
  };
  const closed = () => fail(proxyFailure('Proxy closed connection', { host, port }));
  socket.on('data', data);
  socket.on('error', fail);
  socket.on('close', closed);
  const timer = setTimeout(() => {
    const e = proxyTimeout('Proxy connection timed out', { host, port, timeoutMs });
    fail(e);
    socket.destroy(e);
  }, timeoutMs);
  const read = (size) =>
    new Promise((resolve, reject) => {
      if (failure) return reject(failure);
      pending = { size, resolve, reject };
      drain();
    });
  const exact = (n) => read((b) => (b.length >= n ? n : null));
  try {
    await new Promise((resolve, reject) => {
      const error = (e) => {
        socket.off('connect', ready);
        reject(normalizeProxyError(e, { host, port }));
      };
      const ready = () => {
        socket.off('error', error);
        resolve();
      };
      socket.once('error', error);
      socket.once('connect', ready);
      socket.connect(proxy.port, proxy.host);
    });
    if (proxy.type === 'http') {
      if (/[\r\n\s]/.test(host)) throw proxyFailure('Invalid target host', { port });
      const address = (host.includes(':') ? '[' + host + ']' : host) + ':' + port;
      const auth = proxy.username
        ? 'Proxy-Authorization: Basic ' + Buffer.from(proxy.username + ':' + proxy.password).toString('base64') + '\r\n'
        : '';
      socket.write('CONNECT ' + address + ' HTTP/1.1\r\nHost: ' + address + '\r\n' + auth + '\r\n');
      const header = await read((b) => {
        const n = b.indexOf('\r\n\r\n');
        if (n >= 0) return n + 4;
        if (b.length > 16384) throw proxyFailure('Oversized HTTP proxy header', { host, port, limit: 16384 });
        return null;
      });
      if (!/^HTTP\/1\.[01] 200(?:\s|$)/.test(header.toString('latin1')))
        throw proxyFailure('HTTP proxy CONNECT rejected', { host, port });
    } else if (proxy.type === 'socks5') {
      const method = proxy.username ? 2 : 0;
      socket.write(Buffer.from([5, 1, method]));
      const hello = await exact(2);
      if (hello[0] !== 5 || hello[1] !== method)
        throw proxyFailure('SOCKS5 authentication method rejected', { host, port, method });
      if (method === 2) {
        const u = Buffer.from(proxy.username),
          p = Buffer.from(proxy.password);
        if (u.length > 255 || p.length > 255) throw proxyFailure('SOCKS5 credentials too long', { host, port });
        socket.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([p.length]), p]));
        const result = await exact(2);
        if (result[0] !== 1 || result[1] !== 0) throw proxyFailure('SOCKS5 authentication rejected', { host, port });
      }
      const domain = Buffer.from(host);
      if (!domain.length || domain.length > 255) throw proxyFailure('Invalid SOCKS5 target', { host, port });
      const targetPort = Buffer.alloc(2);
      targetPort.writeUInt16BE(port);
      socket.write(
        command === 3
          ? Buffer.from([5, 3, 0, 1, 0, 0, 0, 0, 0, 0])
          : Buffer.concat([Buffer.from([5, 1, 0, 3, domain.length]), domain, targetPort]),
      );
      const result = await exact(4);
      if (result[0] !== 5 || result[1] !== 0 || result[2] !== 0)
        throw proxyFailure('SOCKS5 ' + (command === 3 ? 'UDP ASSOCIATE' : 'CONNECT') + ' rejected: ' + result[1], {
          host,
          port,
          reply: result[1],
          command,
        });
      if (result[3] === 1) {
        const b = await exact(6);
        bound = { host: [...b.subarray(0, 4)].join('.'), port: b.readUInt16BE(4) };
      } else if (result[3] === 4) {
        const b = await exact(18);
        bound = {
          host: Array.from({ length: 8 }, (_, i) => b.readUInt16BE(i * 2).toString(16)).join(':'),
          port: b.readUInt16BE(16),
        };
      } else if (result[3] === 3) {
        const length = (await exact(1))[0],
          b = await exact(length + 2);
        bound = { host: b.subarray(0, length).toString(), port: b.readUInt16BE(length) };
      } else throw proxyFailure('Invalid SOCKS5 reply address', { host, port, addressType: result[3] });
    } else throw proxyFailure('Unsupported proxy type', { type: proxy.type });
    socket.pause();
    socket.off('data', data);
    if (buffer.length) socket.unshift(buffer);
    return bound;
  } finally {
    clearTimeout(timer);
    socket.off('data', data);
    socket.off('error', fail);
    socket.off('close', closed);
  }
}
function connectSocket(socket, { host, port, proxy }, ready) {
  if (!proxy) {
    socket.connect(port, host, ready);
    return;
  }
  tunnel(socket, host, port, proxy)
    .then(() => {
      ready();
      socket.resume();
    })
    .catch((e) => socket.destroy(e));
}
async function associateUdp(proxy) {
  const socket = new (require('node:net').Socket)();
  socket.on('error', () => {});
  try {
    const relay = await tunnel(socket, '0.0.0.0', 0, proxy, 3, 3000);
    if (!relay.port) throw proxyFailure('SOCKS5 returned an invalid UDP relay port', { reply: relay.port });
    if (['0.0.0.0', '0:0:0:0:0:0:0:0'].includes(relay.host)) relay.host = socket.remoteAddress || proxy.host;
    socket.resume();
    return { socket, relay };
  } catch (e) {
    socket.destroy();
    throw e;
  }
}
module.exports = { loadProxy, loadPool, parseProxy, connectSocket, associateUdp };
