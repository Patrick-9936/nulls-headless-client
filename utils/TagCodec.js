const PLAYER_CHARS = '0289PYLQGRJCUV';
const BASE = BigInt(PLAYER_CHARS.length);

function normalizeTag(tag) {
  if (tag === undefined || tag === null) throw new Error('Player tag is empty');
  const clean = String(tag).trim().toUpperCase().replace(/^#/, '').replace(/O/g,'0');
  if (!clean) throw new Error('Player tag is empty');
  return clean;
}

// Supercell tag integer. This is NOT the same thing as the 64-bit LogicLong.
function tagToEncodedId(tag) {
  const clean = normalizeTag(tag);
  let value = 0n;
  for (const ch of clean) {
    const idx = PLAYER_CHARS.indexOf(ch);
    if (idx < 0) throw new Error(`Invalid player-tag character: ${ch}`);
    value = value * BASE + BigInt(idx);
  }
  return value;
}

function encodedIdToTag(value) {
  let v = BigInt(value);
  if (v < 0n) throw new Error('Encoded tag ID must be non-negative');
  if (v === 0n) return '#0';
  let out = '';
  while (v > 0n) {
    const idx = Number(v % BASE);
    out = PLAYER_CHARS[idx] + out;
    v /= BASE;
  }
  return '#' + out;
}

// Brawl/Supercell player tags pack LogicLong as:
// encodedTagId = (low << 8) | (high & 0xff)
function tagToLogicLong(tag) {
  const encodedId = tagToEncodedId(tag);
  const hi = Number(encodedId & 0xffn) >>> 0;
  const loBig = encodedId >> 8n;
  if (loBig > 0xffffffffn) throw new Error('Tag decodes to a low ID larger than uint32');
  const lo = Number(loBig) >>> 0;
  const logicLong = (BigInt(hi) << 32n) | BigInt(lo);
  return { hi, lo, value: logicLong, encodedId, tag: '#' + normalizeTag(tag) };
}

function logicLongPartsToEncodedId(hi, lo) {
  const h = BigInt(Number(hi) >>> 0);
  const l = BigInt(Number(lo) >>> 0);
  if (h > 255n) throw new Error('Player-tag high ID must fit in 8 bits (0..255)');
  return (l << 8n) | h;
}

function logicLongToTag(hi, lo) {
  return encodedIdToTag(logicLongPartsToEncodedId(hi, lo));
}

function decimalLogicIdToParts(id) {
  const text = String(id).trim();
  if (!/^\d+$/.test(text)) throw new Error('LogicLong decimal ID must contain digits only');
  const value = BigInt(text);
  if (value < 0n || value > 0xffffffffffffffffn) throw new Error('LogicLong decimal ID must fit uint64');
  const hi = Number((value >> 32n) & 0xffffffffn) >>> 0;
  const lo = Number(value & 0xffffffffn) >>> 0;
  const result = { hi, lo, value };
  if (hi <= 255) {
    result.encodedId = logicLongPartsToEncodedId(hi, lo);
    result.tag = encodedIdToTag(result.encodedId);
  }
  return result;
}

const decimalIdToLogicLong = decimalLogicIdToParts;

function describeTag(tag) {
  const p = tagToLogicLong(tag);
  return {
    tag: p.tag,
    encodedTagId: p.encodedId.toString(),
    high: p.hi,
    low: p.lo,
    logicLongDecimal: p.value.toString(),
  };
}

module.exports = {
  PLAYER_CHARS,
  normalizeTag,
  tagToEncodedId,
  encodedIdToTag,
  tagToLogicLong,
  logicLongPartsToEncodedId,
  logicLongToTag,
  decimalLogicIdToParts,
  decimalIdToLogicLong,
  describeTag,
};
