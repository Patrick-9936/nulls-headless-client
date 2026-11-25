'use strict';
// Публичные списки прокси + внешний конфиг.
//
// sources          — проверенные публичные списки (curl 200 + текст, проверка 2026-11-22)
// rejected         — списки, которые отвалились при проверке; оставлены как справка
// loadConfig(root) — ~/nulls/.runtime/proxy-sources.json
// collectLocal()   — диапазоны портов локальной фермы (xray и т.п.)
//
// Публичные источники фильтруются как раньше: только IPv4, без приватных
// диапазонов и без логина/пароля. Отдельный источник из конфига может
// разрешить приватные адреса (allowPrivate) и авторизацию (auth).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseProxy } = require('../utils/ProxyConnect');

const DEFAULT_ROOT = path.join(os.homedir(), 'nulls');
const CONFIG_RELATIVE = path.join('.runtime', 'proxy-sources.json');
const PROTOCOLS = new Set(['socks4', 'socks5', 'http']);

const sources = [
  // --- socks5 ---
  ['proxifly-socks5', 'socks5', 'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/socks5/data.txt'],
  ['monosans-socks5', 'socks5', 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt'],
  ['monosans-all', 'socks5', 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/all.txt'],
  ['proxifly-all', 'socks5', 'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/all/data.txt'],
  ['speedx-socks5', 'socks5', 'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt'],
  ['hookzof-socks5', 'socks5', 'https://raw.githubusercontent.com/hookzof/socks5_list/master/proxy.txt'],
  ['jetkai-socks5', 'socks5', 'https://raw.githubusercontent.com/jetkai/proxy-list/main/online-proxies/txt/proxies-socks5.txt'],
  ['roosterkid-socks5', 'socks5', 'https://raw.githubusercontent.com/roosterkid/openproxylist/main/SOCKS5_RAW.txt'],
  ['mmpx12-socks5', 'socks5', 'https://raw.githubusercontent.com/mmpx12/proxy-list/master/socks5.txt'],
  ['elliott-socks5', 'socks5', 'https://raw.githubusercontent.com/elliottophellia/proxylist/master/results/socks5/global/socks5_checked.txt'],
  ['zloi-socks5', 'socks5', 'https://raw.githubusercontent.com/zloi-user/hideip.me/main/socks5.txt'],
  ['shiftytr-socks5', 'socks5', 'https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/socks5.txt'],
  ['prxchk-socks5', 'socks5', 'https://raw.githubusercontent.com/prxchk/proxy-list/main/socks5.txt'],
  ['vakhov-socks5', 'socks5', 'https://raw.githubusercontent.com/vakhov/fresh-proxy-list/master/socks5.txt'],
  ['aliilapro-socks5', 'socks5', 'https://raw.githubusercontent.com/ALIILAPRO/Proxy/main/socks5.txt'],
  ['murongpig-socks5', 'socks5', 'https://raw.githubusercontent.com/MuRongPIG/Proxy-Master/main/socks5.txt'],
  ['rdavydov-socks5', 'socks5', 'https://raw.githubusercontent.com/rdavydov/proxy-list/main/proxies/socks5.txt'],
  ['b4rc0de-socks5', 'socks5', 'https://raw.githubusercontent.com/B4RC0DE-TM/proxy-list/main/SOCKS5.txt'],
  ['zevtyardt-socks5', 'socks5', 'https://raw.githubusercontent.com/zevtyardt/proxy-list/main/socks5.txt'],
  ['zaeem20-socks5', 'socks5', 'https://raw.githubusercontent.com/Zaeem20/FREE_PROXIES_LIST/master/socks5.txt'],
  ['openproxylist-socks5', 'socks5', 'https://api.openproxylist.xyz/socks5.txt'],
  ['proxyscrape-github-socks5', 'socks5', 'https://raw.githubusercontent.com/proxyscrape/free-proxy-list/main/proxies/protocols/socks5/data.txt'],
  ['iplocate-socks5', 'socks5', 'https://raw.githubusercontent.com/iplocate/free-proxy-list/main/protocols/socks5.txt'],
  ['anonym0us-socks5', 'socks5', 'https://raw.githubusercontent.com/Anonym0usWork1221/Free-Proxies/main/proxy_files/socks5_proxies.txt'],
  ['proxyspace-socks5', 'socks5', 'https://proxyspace.pro/socks5.txt'],
  ['proxyscrape-socks5', 'socks5', 'https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=socks5&proxy_format=ipport&format=text'],
  ['geonode-socks5', 'socks5', 'https://proxylist.geonode.com/api/proxy-list?limit=500&page=1&sort_by=lastChecked&sort_type=desc&protocols=socks5'],
  ['databay-socks5', 'socks5', 'https://raw.githubusercontent.com/databay-labs/free-proxy-list/master/socks5.txt'],

  // --- socks4 ---
  ['proxifly-socks4', 'socks4', 'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/socks4/data.txt'],
  ['monosans-socks4', 'socks4', 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks4.txt'],
  ['speedx-socks4', 'socks4', 'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks4.txt'],
  ['jetkai-socks4', 'socks4', 'https://raw.githubusercontent.com/jetkai/proxy-list/main/online-proxies/txt/proxies-socks4.txt'],
  ['roosterkid-socks4', 'socks4', 'https://raw.githubusercontent.com/roosterkid/openproxylist/main/SOCKS4_RAW.txt'],
  ['mmpx12-socks4', 'socks4', 'https://raw.githubusercontent.com/mmpx12/proxy-list/master/socks4.txt'],
  ['elliott-socks4', 'socks4', 'https://raw.githubusercontent.com/elliottophellia/proxylist/master/results/socks4/global/socks4_checked.txt'],
  ['zloi-socks4', 'socks4', 'https://raw.githubusercontent.com/zloi-user/hideip.me/main/socks4.txt'],
  ['shiftytr-socks4', 'socks4', 'https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/socks4.txt'],
  ['prxchk-socks4', 'socks4', 'https://raw.githubusercontent.com/prxchk/proxy-list/main/socks4.txt'],
  ['vakhov-socks4', 'socks4', 'https://raw.githubusercontent.com/vakhov/fresh-proxy-list/master/socks4.txt'],
  ['aliilapro-socks4', 'socks4', 'https://raw.githubusercontent.com/ALIILAPRO/Proxy/main/socks4.txt'],
  ['murongpig-socks4', 'socks4', 'https://raw.githubusercontent.com/MuRongPIG/Proxy-Master/main/socks4.txt'],
  ['rdavydov-socks4', 'socks4', 'https://raw.githubusercontent.com/rdavydov/proxy-list/main/proxies/socks4.txt'],
  ['b4rc0de-socks4', 'socks4', 'https://raw.githubusercontent.com/B4RC0DE-TM/proxy-list/main/SOCKS4.txt'],
  ['zevtyardt-socks4', 'socks4', 'https://raw.githubusercontent.com/zevtyardt/proxy-list/main/socks4.txt'],
  ['openproxylist-socks4', 'socks4', 'https://api.openproxylist.xyz/socks4.txt'],
  ['iplocate-socks4', 'socks4', 'https://raw.githubusercontent.com/iplocate/free-proxy-list/main/protocols/socks4.txt'],
  ['anonym0us-socks4', 'socks4', 'https://raw.githubusercontent.com/Anonym0usWork1221/Free-Proxies/main/proxy_files/socks4_proxies.txt'],
  ['proxyspace-socks4', 'socks4', 'https://proxyspace.pro/socks4.txt'],
  ['proxyscrape-socks4', 'socks4', 'https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=socks4&proxy_format=ipport&format=text'],
  ['geonode-socks4', 'socks4', 'https://proxylist.geonode.com/api/proxy-list?limit=500&page=1&sort_by=lastChecked&sort_type=desc&protocols=socks4'],
  ['databay-socks4', 'socks4', 'https://raw.githubusercontent.com/databay-labs/free-proxy-list/master/socks4.txt'],

  // --- http ---
  ['proxifly-http', 'http', 'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/http/data.txt'],
  ['monosans-http', 'http', 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt'],
  ['speedx-http', 'http', 'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt'],
  ['jetkai-http', 'http', 'https://raw.githubusercontent.com/jetkai/proxy-list/main/online-proxies/txt/proxies-http.txt'],
  ['roosterkid-https', 'http', 'https://raw.githubusercontent.com/roosterkid/openproxylist/main/HTTPS_RAW.txt'],
  ['mmpx12-http', 'http', 'https://raw.githubusercontent.com/mmpx12/proxy-list/master/http.txt'],
  ['elliott-http', 'http', 'https://raw.githubusercontent.com/elliottophellia/proxylist/master/results/http/global/http_checked.txt'],
  ['zloi-http', 'http', 'https://raw.githubusercontent.com/zloi-user/hideip.me/main/http.txt'],
  ['zloi-https', 'http', 'https://raw.githubusercontent.com/zloi-user/hideip.me/main/https.txt'],
  ['mmpx12-https', 'http', 'https://raw.githubusercontent.com/mmpx12/proxy-list/master/https.txt'],
  ['clarketm', 'http', 'https://raw.githubusercontent.com/clarketm/proxy-list/master/proxy-list-raw.txt'],
  ['shiftytr-http', 'http', 'https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/http.txt'],
  ['prxchk-http', 'http', 'https://raw.githubusercontent.com/prxchk/proxy-list/main/http.txt'],
  ['vakhov-http', 'http', 'https://raw.githubusercontent.com/vakhov/fresh-proxy-list/master/http.txt'],
  ['aliilapro-http', 'http', 'https://raw.githubusercontent.com/ALIILAPRO/Proxy/main/http.txt'],
  ['murongpig-http', 'http', 'https://raw.githubusercontent.com/MuRongPIG/Proxy-Master/main/http.txt'],
  ['rdavydov-http', 'http', 'https://raw.githubusercontent.com/rdavydov/proxy-list/main/proxies/http.txt'],
  ['b4rc0de-http', 'http', 'https://raw.githubusercontent.com/B4RC0DE-TM/proxy-list/main/HTTP.txt'],
  ['zevtyardt-http', 'http', 'https://raw.githubusercontent.com/zevtyardt/proxy-list/main/http.txt'],
  ['zaeem20-http', 'http', 'https://raw.githubusercontent.com/Zaeem20/FREE_PROXIES_LIST/master/http.txt'],
  ['saisuiu-http', 'http', 'https://raw.githubusercontent.com/saisuiu/Lionkings-Http-Proxys-Proxies/main/cnfree.txt'],
  ['openproxylist-http', 'http', 'https://api.openproxylist.xyz/http.txt'],
  ['proxy4parsing-http', 'http', 'https://raw.githubusercontent.com/proxy4parsing/proxy-list/main/http.txt'],
  ['iplocate-http', 'http', 'https://raw.githubusercontent.com/iplocate/free-proxy-list/main/protocols/http.txt'],
  ['anonym0us-http', 'http', 'https://raw.githubusercontent.com/Anonym0usWork1221/Free-Proxies/main/proxy_files/http_proxies.txt'],
  ['proxyspace-http', 'http', 'https://proxyspace.pro/http.txt'],
  ['proxyscrape-http', 'http', 'https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=http&proxy_format=ipport&format=text'],
  ['geonode-http', 'http', 'https://proxylist.geonode.com/api/proxy-list?limit=500&page=1&sort_by=lastChecked&sort_type=desc&protocols=http'],
  ['databay-http', 'http', 'https://raw.githubusercontent.com/databay-labs/free-proxy-list/master/http.txt'],
].map(([name, protocol, url]) => ({ name, protocol, url }));

// Проверено 2026-11-22 curl -sL -o /dev/null -w '%{http_code}'. Не включаются в
// sources, потому что либо 404, либо хост не резолвится, либо отдаёт 403/502.
const rejected = [
  { name: 'openproxyspace', url: 'https://openproxyspace.com/api/free-proxy-list?protocol=socks5&format=txt', status: 'DNS/connect failed' },
  { name: 'proxyscan', url: 'https://proxyscan.io/api/proxy_list?type=socks5', status: 'HTTP 403' },
  { name: 'proxy-list.download', url: 'https://www.proxy-list.download/api/v1/get?type=socks5', status: 'HTTP 502/429' },
  { name: 'monosans-anonymous', url: 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies_anonymous/socks5.txt', status: 'HTTP 404' },
  { name: 'officialputuid-kangproxy', url: 'https://raw.githubusercontent.com/officialputuid/KangProxy/KangProxy/socks5/socks5.txt', status: 'HTTP 404' },
  { name: 'sunu', url: 'https://raw.githubusercontent.com/sunu/proxy-list/main/socks5.txt', status: 'HTTP 404' },
  { name: 'vip-ip', url: 'https://raw.githubusercontent.com/vip-ip/proxy-list/main/socks5.txt', status: 'HTTP 404' },
  { name: 'yemixzy', url: 'https://raw.githubusercontent.com/yemixzy/proxy-list/main/proxies/socks5.txt', status: 'HTTP 404' },
];

function expandHome(value) {
  const text = String(value || '');
  if (text === '~') return os.homedir();
  if (text.startsWith('~/')) return path.join(os.homedir(), text.slice(2));
  return text;
}

function configPath(root) {
  const base = root ? path.resolve(expandHome(root)) : DEFAULT_ROOT;
  return path.extname(base) === '.json' ? base : path.join(base, CONFIG_RELATIVE);
}

function isPrivateIp(ip) {
  if (!Array.isArray(ip) || ip.length !== 4) return false;
  return (
    ip[0] === 0 ||
    ip[0] === 10 ||
    ip[0] === 127 ||
    ip[0] >= 224 ||
    (ip[0] === 169 && ip[1] === 254) ||
    (ip[0] === 172 && ip[1] >= 16 && ip[1] <= 31) ||
    (ip[0] === 192 && ip[1] === 168) ||
    (ip[0] === 100 && ip[1] >= 64 && ip[1] <= 127)
  );
}

function normalizeAuth(auth) {
  if (!auth || auth === true) return auth === true ? true : null;
  if (typeof auth === 'object') {
    const username = auth.username ?? auth.user;
    const password = auth.password ?? auth.pass ?? '';
    if (username === undefined || username === null || username === '') return null;
    return { username: String(username), password: String(password) };
  }
  return null;
}

// normalize(value, protocol, {allowPrivate, auth}) -> канонический URL или null.
// allowPrivate разрешает 10/172.16-31/192.168/127/100.64-127 и имена хостов,
// auth разрешает user:pass@ (auth === true) или подставляет общие креды (объект).
function normalize(value, protocol = 'socks5', opts = {}) {
  const options = opts && typeof opts === 'object' ? opts : {};
  const allowPrivate = options.allowPrivate === true;
  const credentials = normalizeAuth(options.auth);
  try {
    const text = String(value ?? '').trim();
    if (!text || /\s/.test(text)) return null;
    const input = text.includes('://') ? text : `${protocol}://${text}`;
    const p = parseProxy(input);
    const ip = p.host.split('.').map(Number);
    const ipv4 = /^\d+\.\d+\.\d+\.\d+$/.test(p.host) && ip.every((n) => n >= 0 && n <= 255);
    if (!ipv4) {
      // Публичные списки — только IPv4. Локальная ферма может быть на имени хоста.
      if (!allowPrivate || !/^[a-z0-9._-]+$/i.test(p.host)) return null;
    } else if (!allowPrivate && isPrivateIp(ip)) return null;

    const hasOwnAuth = Boolean(p.username || p.password);
    if (hasOwnAuth && !allowPrivate && !options.auth) return null;
    if (hasOwnAuth && credentials && credentials !== true) return null; // общие креды не перебивают свои

    let auth = '';
    if (hasOwnAuth) {
      if (options.auth !== true && !credentials) return null;
      auth = `${encodeURIComponent(p.username)}:${encodeURIComponent(p.password)}@`;
    } else if (credentials && credentials !== true) {
      auth = `${encodeURIComponent(credentials.username)}:${encodeURIComponent(credentials.password)}@`;
    }
    const u = new URL(input);
    if ((u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) return null;
    return `${p.type}://${auth}${p.host}:${p.port}`;
  } catch {
    return null;
  }
}

// Разбирает произвольный текст: построчно, плюс JSON (geonode/proxifly) и
// строки с мусором вида "1.2.3.4:8080,US,elite".
function parseText(text, protocol = 'socks5', opts = {}) {
  const options = opts && typeof opts === 'object' ? opts : {};
  const out = [];
  const seen = new Set();
  const add = (value) => {
    const proxy = normalize(value, protocol, options);
    if (proxy && !seen.has(proxy)) {
      seen.add(proxy);
      out.push(proxy);
    }
  };
  const body = String(text ?? '');
  const trimmed = body.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) for (const item of jsonProxies(trimmed)) add(item);
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;
    if (line.startsWith('{') || line.startsWith('[') || line.startsWith('"')) continue;
    const direct = normalize(line, protocol, options);
    if (direct) {
      if (!seen.has(direct)) {
        seen.add(direct);
        out.push(direct);
      }
      continue;
    }
    // Явный URL, который не прошёл normalize, не спасаем регуляркой: иначе
    // строка с кредами вернулась бы без них.
    if (line.includes('://')) continue;
    const matches = line.match(/(?:\d{1,3}\.){3}\d{1,3}:\d{1,5}/g);
    if (matches) for (const match of matches) add(match);
  }
  return out;
}

function jsonProxies(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const out = [];
  const walk = (node, depth) => {
    if (!node || depth > 6 || out.length > 20000) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    if (typeof node !== 'object') return;
    const host = node.ip ?? node.host ?? node.ipAddress ?? node.address;
    const port = node.port ?? node.proxy_port ?? node.proxyPort;
    if (host && port !== undefined && port !== null && /^\d+$/.test(String(port))) {
      const raw = Array.isArray(node.protocols) ? node.protocols[0] : (node.protocol ?? node.type);
      const proto = raw ? String(raw).replace(/:$/, '').replace(/:\/\//, '') : '';
      out.push(PROTOCOLS.has(proto) ? `${proto}://${host}:${port}` : `${host}:${port}`);
      return;
    }
    for (const value of Object.values(node)) walk(value, depth + 1);
  };
  walk(data, 0);
  return out;
}

async function download(source, signal, maxBytes = 262144) {
  const response = await fetch(source.url, { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const reader = response.body.getReader();
  let length = 0;
  const parts = [];
  let truncated = false;
  try {
    while (length < maxBytes) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value.subarray(0, maxBytes - length);
      parts.push(Buffer.from(chunk));
      length += chunk.length;
      if (length === maxBytes) {
        truncated = true;
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  let text = Buffer.concat(parts, length).toString('utf8');
  if (truncated) text = text.slice(0, Math.max(0, text.lastIndexOf('\n')));
  return { text, truncated, bytes: length };
}

function select(groups, previous, limit, cycle = 0) {
  const result = [],
    seen = new Set();
  const add = (value) => {
    if (value && !seen.has(value) && result.length < limit) {
      seen.add(value);
      result.push(value);
    }
  };
  previous.slice(0, Math.floor(limit / 3)).forEach((value) => add(normalize(value)));
  // Round-robin sources; rotate each source's starting point so stale top entries cannot starve new ones.
  for (let offset = 0; result.length < limit && offset < Math.max(0, ...groups.map((g) => g.length)); offset++) {
    for (const g of groups) if (offset < g.length) add(g[(offset + cycle * 37) % g.length]);
  }
  return result;
}

// Читает внешний конфиг. Отсутствующий файл — пустой массив; битый — исключение
// с путём, чтобы CLI напечатал причину, а не молча проглотил конфиг.
function loadConfig(root) {
  const file = configPath(root);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw new Error(`proxy config ${file}: ${error.message}`);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(`proxy config ${file}: ${error.message}`);
  }
  const list = Array.isArray(data) ? data : Array.isArray(data?.sources) ? data.sources : [];
  const out = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object' || entry.enabled === false) continue;
    const protocol = PROTOCOLS.has(String(entry.protocol)) ? String(entry.protocol) : 'socks5';
    const auth = normalizeAuth(entry.auth);
    out.push({
      name: String(entry.name || 'config'),
      protocol,
      url: entry.url ? String(entry.url) : null,
      host: entry.host ? String(entry.host) : null,
      ports: entry.ports !== undefined && entry.ports !== null ? String(entry.ports) : null,
      allowPrivate: entry.allowPrivate === true,
      auth: auth === true || auth ? auth : null,
      enabled: true,
      fromConfig: true,
    });
  }
  return out;
}

function expandPorts(spec) {
  const out = [];
  for (const part of String(spec ?? '').split(',')) {
    const token = part.trim();
    if (!token) continue;
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(token);
    if (range) {
      let start = Number(range[1]);
      let end = Number(range[2]);
      if (start > end) [start, end] = [end, start];
      for (let port = start; port <= end; port++) if (port > 0 && port <= 65535) out.push(port);
    } else if (/^\d+$/.test(token)) {
      const port = Number(token);
      if (port > 0 && port <= 65535) out.push(port);
    }
  }
  return out;
}

// Локальная ферма: {host, ports} из конфига -> socks5://[user:pass@]host:port.
// opts = {root, config, maxPorts}; config позволяет передать уже прочитанный массив.
function collectLocal(opts = {}) {
  const options = opts && typeof opts === 'object' ? opts : {};
  const entries = Array.isArray(options.config)
    ? options.config
    : (() => {
        try {
          return loadConfig(options.root);
        } catch {
          return [];
        }
      })();
  const limit = Number.isInteger(options.maxPorts) && options.maxPorts > 0 ? options.maxPorts : 4096;
  const out = [];
  const seen = new Set();
  for (const entry of entries) {
    if (!entry || !entry.host || !entry.ports) continue;
    const ports = expandPorts(entry.ports);
    const auth = entry.auth && entry.auth !== true ? entry.auth : null;
    const prefix = auth
      ? `${entry.protocol}://${encodeURIComponent(auth.username)}:${encodeURIComponent(auth.password)}@`
      : `${entry.protocol}://`;
    for (const port of ports) {
      if (out.length >= limit) return out;
      const url = `${prefix}${entry.host}:${port}`;
      if (seen.has(url)) continue;
      seen.add(url);
      out.push(url);
    }
  }
  return out;
}

module.exports = {
  sources,
  rejected,
  normalize,
  normalizeAuth,
  isPrivateIp,
  parseText,
  expandPorts,
  download,
  select,
  configPath,
  loadConfig,
  collectLocal,
  DEFAULT_ROOT,
};