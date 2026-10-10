const {parseProxy} = require('../utils/ProxyConnect');
const sources = [
  ['proxifly-socks5', 'socks5', 'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/socks5/data.txt'],
  ['monosans-socks5', 'socks5', 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt'],
  ['speedx-socks5', 'socks5', 'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt'],
  ['hookzof-socks5', 'socks5', 'https://raw.githubusercontent.com/hookzof/socks5_list/master/proxy.txt'],
  ['jetkai-socks5', 'socks5', 'https://raw.githubusercontent.com/jetkai/proxy-list/main/online-proxies/txt/proxies-socks5.txt'],
  ['proxifly-http', 'http', 'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/http/data.txt'],
  ['monosans-http', 'http', 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt'],
  ['speedx-http', 'http', 'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt'],
].map(([name, protocol, url]) => ({name, protocol, url}));

function normalize(value, protocol = 'socks5') {
  try {
    const input = value.includes('://') ? value : `${protocol}://${value}`;
    const p = parseProxy(input), ip = p.host.split('.').map(Number);
    // Public list entries never need credentials or access to local/private networks.
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(p.host) || ip.some(n => n < 0 || n > 255)) return null;
    if ([0, 10, 127].includes(ip[0]) || ip[0] >= 224 || (ip[0] === 169 && ip[1] === 254)
      || (ip[0] === 172 && ip[1] >= 16 && ip[1] <= 31) || (ip[0] === 192 && ip[1] === 168)
      || (ip[0] === 100 && ip[1] >= 64 && ip[1] <= 127) || p.username || p.password) return null;
    const u = new URL(input); if (u.pathname !== '/' && u.pathname !== '' || u.search || u.hash) return null;
    return `${p.type}://${p.host}:${p.port}`;
  } catch {return null;}
}

async function download(source, signal, maxBytes = 262144) {
  const response = await fetch(source.url, {signal});
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const reader = response.body.getReader(); let length = 0; const parts = [];
  let truncated = false;
  try {
    while (length < maxBytes) {
      const next = await reader.read(); if (next.done) break;
      const chunk = next.value.subarray(0, maxBytes - length);
      parts.push(Buffer.from(chunk)); length += chunk.length;
      if (length === maxBytes) {truncated = true; break;}
    }
  } finally {await reader.cancel().catch(() => {});}
  let text = Buffer.concat(parts, length).toString('utf8');
  if (truncated) text = text.slice(0, Math.max(0, text.lastIndexOf('\n')));
  return {text, truncated, bytes: length};
}

function select(groups, previous, limit, cycle = 0) {
  const result = [], seen = new Set();
  const add = value => {if (value && !seen.has(value) && result.length < limit) {seen.add(value); result.push(value);}};
  previous.slice(0, Math.floor(limit / 3)).forEach(value => add(normalize(value)));
  // Round-robin sources; rotate each source's starting point so stale top entries cannot starve new ones.
  for (let offset = 0; result.length < limit && offset < Math.max(0, ...groups.map(g => g.length)); offset++) {
    for (const g of groups) if (offset < g.length) add(g[(offset + cycle * 37) % g.length]);
  }
  return result;
}
module.exports = {sources, normalize, download, select};
