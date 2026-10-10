let colors;
try { colors = require('colors/safe'); }
catch { colors = { brightYellow:x=>x, brightCyan:x=>x, brightRed:x=>x }; }

global.Debugger = {
  warn: (...args) => console.log(colors.brightYellow('[WARN]'), ...args),
  info: (...args) => console.log(colors.brightCyan('[INFO]'), ...args),
  error: (...args) => console.log(colors.brightRed('[ERROR]'), ...args),
  fatal: (...args) => { console.log(colors.brightRed('[FATAL]'), ...args); process.exit(1); }
};
