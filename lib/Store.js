const fs = require('node:fs');
const path = require('node:path');

function read(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function write(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', {mode: 0o600});
  fs.renameSync(temporary, file);
}

module.exports = {read, write};
