'use strict';
// Мини-слой локализации без зависимостей. Каталоги — плоские JSON с точечными
// ключами (lib/locales/<lang>.json). Загрузка ленивая: require не читает диск.
const fs = require('node:fs');
const path = require('node:path');

const SUPPORTED = ['ru', 'en', 'tr', 'zh'];
const DEFAULT = 'ru';
const FALLBACK = 'en';
const NAMES = { ru: 'Русский', en: 'English', tr: 'Türkçe', zh: '中文' };
const LOCALES_DIR = path.join(__dirname, 'locales');
const cache = new Map();
let current = DEFAULT;

// 'ru-RU' / 'ru_RU.UTF-8' / 'EN' -> 'ru' / 'en'; мусор -> null
function normalize(tag) {
  if (typeof tag !== 'string') return null;
  const base = tag.trim().toLowerCase().replace(/_/g, '-').split('-')[0].split('.')[0];
  return base || null;
}

function resolve(requested) {
  const base = normalize(requested);
  if (!base) return null;
  return SUPPORTED.includes(base) ? base : null;
}

function catalogFile(lang) {
  return path.join(LOCALES_DIR, `${lang}.json`);
}

// Читает и кэширует каталог. Неизвестный язык -> null (без исключения).
function load(lang) {
  const code = resolve(lang);
  if (!code) return null;
  if (cache.has(code)) return cache.get(code);
  const file = catalogFile(code);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`Не удалось загрузить каталог i18n ${file}: ${error.message}`);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Каталог i18n ${file} содержит некорректный JSON: ${error.message}`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`Каталог i18n ${file} должен быть объектом с плоскими ключами`);
  }
  cache.set(code, data);
  return data;
}

function languages() {
  return SUPPORTED.slice();
}

function label(code) {
  const base = resolve(code);
  return base ? NAMES[base] || base : null;
}

function setLanguage(lang) {
  const code = resolve(lang);
  if (!code) throw new Error(`Язык «${lang}» не поддерживается; доступны: ${SUPPORTED.join(', ')}`);
  current = code;
  return current;
}

function getLanguage() {
  return current;
}

function lookup(key, code) {
  const data = load(code);
  return data && Object.hasOwn(data, key) ? data[key] : undefined;
}

// Порядок поиска: текущий язык -> en -> ru -> сам ключ.
function raw(key) {
  for (const code of [current, FALLBACK, DEFAULT]) {
    const value = lookup(key, code);
    if (typeof value === 'string') return value;
  }
  return undefined;
}

function format(template, params) {
  if (!params || typeof params !== 'object') return template;
  return template.replace(/\{(\w+)\}/g, (match, name) =>
    params[name] === undefined || params[name] === null ? match : String(params[name]),
  );
}

function t(key, params) {
  if (typeof key !== 'string' || !key) return key ?? '';
  const template = raw(key);
  if (template === undefined) return key;
  return format(template, params);
}

function has(key) {
  return typeof key === 'string' && raw(key) !== undefined;
}

// Приоритет: явный --lang/options.lang -> config.uiLanguage -> env -> ru.
function fromEnv(env = process.env) {
  for (const name of ['NULLS_LANG', 'LC_ALL', 'LC_MESSAGES', 'LANG']) {
    const code = resolve(env[name]);
    if (code) return code;
  }
  return null;
}

function detect({ lang, config, env } = {}) {
  return resolve(lang) || resolve(config && config.uiLanguage) || fromEnv(env) || DEFAULT;
}

// Сброс кэша каталогов (перечитать файлы; используется тестами и валидатором).
function clearCache() {
  cache.clear();
}

module.exports = {
  SUPPORTED,
  DEFAULT,
  resolve,
  load,
  setLanguage,
  getLanguage,
  t,
  has,
  languages,
  label,
  fromEnv,
  detect,
  format,
  clearCache,
};
