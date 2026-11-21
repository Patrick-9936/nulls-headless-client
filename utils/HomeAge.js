const ByteStream = require('../DataStream/ByteStream');
// Модуль может загрузиться до инициализации глобального Debugger (например, из теста),
// поэтому используется безопасный фолбэк на console.warn.
const warn = (...args) => (typeof Debugger === 'object' && Debugger ? Debugger.warn(...args) : console.warn(...args));
// Перебор идёт по сырому буферу: обрыв на мусорном смещении и повтор ключа — ожидаемый
// исход перебора, а не дефект. Логируем только неожидаемые ошибки.
const EXPECTED_SCAN_ERRORS = new Set(['ByteStream EOF', 'Invalid VInt', 'Invalid string length', 'Invalid flag array']);
// Native ClientHome: country string, optional string, then a counted array
// of (value, key) VInts; age-state key=15 (1=unset, 2=adult, 3=child).
module.exports = function readAgeState(payload) {
  const b = Buffer.from(payload),
    candidates = [];
  for (let off = 0; off + 11 < b.length; off++) {
    if (
      b.readUInt32BE(off) !== 2 ||
      !/^[A-Z]{2}$/.test(b.subarray(off + 4, off + 6).toString('ascii')) ||
      b.readUInt32BE(off + 6) !== 0xffffffff
    )
      continue;
    try {
      const s = new ByteStream();
      s.set(b);
      s.offset = off + 10;
      const count = s.readVInt();
      if (count < 1 || count > 256) continue;
      const flags = {};
      for (let i = 0; i < count; i++) {
        const value = s.readVInt(),
          key = s.readVInt();
        if (key < 0 || key > 10000 || Object.hasOwn(flags, key)) throw new Error('Invalid flag array');
        flags[key] = value;
      }
      if ([1, 2, 3].includes(flags[15]))
        candidates.push({
          state: flags[15],
          adultThreshold: flags[16] ?? 16,
          country: b.subarray(off + 4, off + 6).toString(),
          offset: off,
          flags,
        });
    } catch (error) {
      if (!EXPECTED_SCAN_ERRORS.has(error.message))
        warn(`Возраст из Home: разбор смещения ${off} остановлен — ${error.message}`);
    }
  }
  return candidates.length === 1 ? candidates[0] : null;
};
