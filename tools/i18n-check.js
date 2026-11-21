#!/usr/bin/env node
'use strict';
// Валидатор каталогов локализации. Используется в CI и в tests/i18n.test.js.
const fs = require('node:fs');
const path = require('node:path');
const { SUPPORTED, DEFAULT } = require('../lib/i18n');

const DEFAULT_DIR = path.join(__dirname, '..', 'lib', 'locales');

function placeholders(text) {
  const found = new Set();
  for (const match of String(text).matchAll(/\{(\w+)\}/g)) found.add(match[1]);
  return [...found].sort();
}

function readCatalog(dir, lang, errors) {
  const file = path.join(dir, `${lang}.json`);
  if (!fs.existsSync(file)) {
    errors.push(`${lang}: нет файла ${file}`);
    return null;
  }
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    errors.push(`${lang}: некорректный JSON в ${file}: ${error.message}`);
    return null;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    errors.push(`${lang}: каталог должен быть объектом с плоскими ключами`);
    return null;
  }
  for (const [key, value] of Object.entries(data)) {
    if (typeof value !== 'string') {
      errors.push(`${lang}: ${key} — значение должно быть строкой`);
      continue;
    }
    if (!value.trim()) errors.push(`${lang}: ${key} — пустое значение`);
    if (key !== key.trim() || !key.includes('.')) errors.push(`${lang}: ${key} — ключ должен быть вида group.name`);
  }
  return data;
}

function check(options = {}) {
  const dir = options.dir || DEFAULT_DIR;
  const languages = options.languages || SUPPORTED;
  const base = options.base || DEFAULT;
  const errors = [];
  const catalogs = new Map();
  for (const lang of languages) {
    const data = readCatalog(dir, lang, errors);
    if (data) catalogs.set(lang, data);
  }
  const reference = catalogs.get(base);
  if (!reference) {
    errors.push(`${base}: базовый каталог недоступен, сравнение невозможно`);
    return { ok: false, errors, languages, base };
  }
  const referenceKeys = Object.keys(reference).sort();
  for (const [lang, data] of catalogs) {
    if (lang === base) continue;
    const keys = new Set(Object.keys(data));
    const missing = referenceKeys.filter((key) => !keys.has(key));
    const extra = [...keys].filter((key) => !Object.hasOwn(reference, key)).sort();
    if (missing.length) errors.push(`${lang}: нет ключей (${missing.length}): ${missing.join(', ')}`);
    if (extra.length) errors.push(`${lang}: лишние ключи (${extra.length}): ${extra.join(', ')}`);
    for (const key of referenceKeys) {
      if (!keys.has(key)) continue;
      const expected = placeholders(reference[key]);
      const actual = placeholders(data[key]);
      if (expected.join(',') !== actual.join(',')) {
        errors.push(
          `${lang}: ${key} — плейсхолдеры ${actual.length ? `{${actual.join('} {')}}` : 'отсутствуют'}, ожидались ${expected.length ? `{${expected.join('} {')}}` : 'нет'}`,
        );
      }
    }
  }
  return { ok: errors.length === 0, errors, languages, base, keys: referenceKeys.length };
}

function main() {
  const result = check();
  if (result.ok) {
    console.log(`i18n: каталоги согласованы (${result.languages.join(', ')}), ключей: ${result.keys}`);
    return;
  }
  console.error(`i18n: найдено расхождений — ${result.errors.length}`);
  for (const error of result.errors) console.error(' - ' + error);
  process.exitCode = 1;
}

module.exports = { check, placeholders };
if (require.main === module) main();
