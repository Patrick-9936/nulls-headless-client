const fs = require('node:fs');
const path = require('node:path');
const { AppError, codes, fromFilesystem } = require('./Errors');

// Читает JSON. Битый файл — STORE_CORRUPT с исходным текстом JSON.parse в message.
function read(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw fromFilesystem(error, { file, operation: 'read' });
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new AppError(codes.STORE_CORRUPT, error.message, {
      cause: error,
      details: { file, cause: error.message, operation: 'parse' },
    });
  }
}

// Атомарная запись: временный файл 0600 + rename. Ошибки ФС получают
// PERMISSION_DENIED/FILESYSTEM_ERROR, message остаётся прежним.
function write(file, value) {
  // Ошибка сериализации (цикл, BigInt) остаётся TypeError вызывающего кода.
  const payload = JSON.stringify(value, null, 2) + '\n';
  const temporary = `${file}.tmp-${process.pid}`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temporary, payload, { mode: 0o600 });
    fs.renameSync(temporary, file);
  } catch (error) {
    try {
      fs.unlinkSync(temporary);
    } catch {}
    throw fromFilesystem(error, { file, operation: 'write' });
  }
}

module.exports = { read, write };
