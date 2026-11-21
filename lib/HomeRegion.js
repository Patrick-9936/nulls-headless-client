// Страна аккаунта в HomeData (24101/24180). LoginOk.countryCode — страна по IP,
// она не меняется после 12998; фактическая страна лежит рядом с хостом региона:
// u32 длина=2, код страны, u32 длина, хост. Сканирование по сырому буферу
// безопасно: обрыв или мусорное смещение — обычный промах, а не ошибка разбора.
const COUNTRY = /^[A-Z]{2}$/;
const HOST = /^[A-Za-z0-9.-]{1,253}$/;
const MAX_HOST = 253;

function countryAt(buffer, offset) {
  if (offset < 0 || offset + 10 > buffer.length) return null;
  if (buffer.readUInt32BE(offset) !== 2) return null;
  const country = buffer.subarray(offset + 4, offset + 6).toString('ascii');
  if (!COUNTRY.test(country)) return null;
  const length = buffer.readUInt32BE(offset + 6);
  if (length < 4 || length > MAX_HOST || offset + 10 + length > buffer.length) return null;
  const host = buffer.subarray(offset + 10, offset + 10 + length).toString('ascii');
  if (!HOST.test(host) || !host.includes('.')) return null;
  return { country, host, offset };
}

module.exports = function homeRegion(payload) {
  const buffer = Buffer.from(payload || []);
  for (let offset = 0; offset + 10 <= buffer.length; offset += 1) {
    const found = countryAt(buffer, offset);
    if (found) return found;
  }
  return null;
};
