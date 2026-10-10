const booleans = new Set(['refresh', 'experimental', 'once', 'dump', 'dry-run', 'accept', 'local', 'after-death', 'brawl-tv', 'spectator', 'disabled', 'check', 'watch', 'verify-login', 'auto-update', 'all']);
function parse(argv) {
  const options = {}, positional = [];
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i];
    if (!item.startsWith('--')) {positional.push(item); continue;}
    const [raw, ...inline] = item.slice(2).split('=');
    const key = raw.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (booleans.has(raw)) options[key] = inline.length ? !['false', '0', 'no'].includes(inline.join('=')) : true;
    else {
      const value = inline.length ? inline.join('=') : argv[++i];
      if (value === undefined || value.startsWith('--')) throw new Error(`Для --${raw} нужно значение`);
      options[key] = value;
    }
  }
  for (const key of ['accept', 'familyFriendly', 'disabled']) {
    if (typeof options[key] === 'string') options[key] = !['false', '0', 'no'].includes(options[key]);
  }
  if (options.modifiers !== undefined) options.modifiers = options.modifiers.split(',').filter(Boolean).map(Number);
  return {options, positional};
}
module.exports = {parse};
