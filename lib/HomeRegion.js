// Страна аккаунта в HomeData (24101/24180). LoginOk.countryCode — страна по IP,
// она не меняется после 12998; фактическая страна лежит в паре полей Home:
// u32 длина=2, код страны, u32 длина, хост.
//
// Пара стоит сразу за 16-байтовым якорем (см. ANCHOR). В живых Home 69.252 он
// уникален и не зависит от региона: смещение пары от начала пакета плавает
// (1632 в обычном Home, 1630 в Home без подтверждённого ника), а от якоря — нет.
// Сначала читаем по якорю; если его нет или пара не проходит проверки — старый
// скан по буферу, но с более строгой валидацией и лимитом кандидатов.
const COUNTRY = /^[A-Z]{2}$/;
const HOST = /^(?=.{3,255}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;
const MIN_HOST = 3;
const MAX_HOST = 255;
// Живой маркер: 6 нулей, 90 06 7f, три нуля, 01 10 00. Проверен на четырёх
// Home (RU/KZ/US, ник подтверждён и нет): встречается ровно один раз.
const ANCHOR = Buffer.from('0000000000000090067f000000011000', 'hex');
const MAX_ANCHORS = 8;
const MAX_CANDIDATES = 64;
const MAX_SCAN_BYTES = 1024 * 1024;

function countryAt(buffer, offset) {
  if (offset < 0 || offset + 10 > buffer.length) return null;
  if (buffer.readUInt32BE(offset) !== 2) return null;
  const country = buffer.subarray(offset + 4, offset + 6).toString('ascii');
  if (!COUNTRY.test(country)) return null;
  const length = buffer.readUInt32BE(offset + 6);
  if (length < MIN_HOST || length > MAX_HOST) return null;
  if (offset + 10 + length > buffer.length) return null;
  const host = buffer.subarray(offset + 10, offset + 10 + length).toString('ascii');
  if (!HOST.test(host) || !host.includes('.') || host.includes('..')) return null;
  return { country, host, offset };
}

// Ищет пару строго за якорем. Если якорей несколько и валидных пар тоже
// несколько — не угадываем: пусть решает скан.
function byAnchor(buffer) {
  let found = null;
  let from = 0;
  for (let n = 0; n < MAX_ANCHORS; n += 1) {
    const at = buffer.indexOf(ANCHOR, from);
    if (at < 0) break;
    const record = countryAt(buffer, at + ANCHOR.length);
    if (record) {
      if (found) return null;
      found = record;
    }
    from = at + 1;
  }
  return found;
}

// Фолбэк: прежний побайтовый скан, но кандидатов не больше MAX_CANDIDATES,
// а сам проход ограничен MAX_SCAN_BYTES, чтобы мусорный буфер не крутил цикл.
function byScan(buffer) {
  const end = Math.min(buffer.length, MAX_SCAN_BYTES);
  let candidates = 0;
  for (let offset = 0; offset + 10 <= end; offset += 1) {
    if (buffer[offset] !== 0 || buffer[offset + 1] !== 0 || buffer[offset + 2] !== 0 || buffer[offset + 3] !== 2)
      continue;
    candidates += 1;
    if (candidates > MAX_CANDIDATES) return null;
    const found = countryAt(buffer, offset);
    if (found) return found;
  }
  return null;
}

function found(record, method) {
  // method читается как обычное свойство, но не перечисляется: старый
  // tests/account-region.test.js сравнивает результат целиком через deepEqual.
  return Object.defineProperty(record, 'method', { value: method, enumerable: false });
}

module.exports = function homeRegion(payload) {
  const buffer = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || []);
  const exact = byAnchor(buffer);
  if (exact) return found(exact, 'anchor');
  const scanned = byScan(buffer);
  return scanned ? found(scanned, 'scan') : null;
};
