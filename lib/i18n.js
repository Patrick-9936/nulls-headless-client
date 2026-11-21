'use strict';
// Мини-слой локализации без зависимостей. Каталоги — плоские JSON с точечными
// ключами (lib/locales/<lang>.json). Загрузка ленивая: require не читает диск.
const fs = require('node:fs');
const path = require('node:path');

const SUPPORTED = ['ru', 'en', 'tr', 'zh'];
const DEFAULT = 'ru';
const FALLBACK = 'en';
const AUTO = 'auto';
const ENV_NAMES = ['NULLS_LANG', 'LC_ALL', 'LC_MESSAGES', 'LANG'];
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

// 'auto' — отдельный режим, не язык: явный код важнее, auto включает определение.
function isAuto(value) {
  return normalize(value) === AUTO;
}

// Режим значения: 'auto', поддерживаемый код или null.
function resolveMode(value) {
  if (isAuto(value)) return AUTO;
  return resolve(value);
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
// Возвращает { code, seen }: seen — хотя бы одна локаль-переменная задана,
// даже если она не поддерживается (например, LANG=C).
function envLocale(env = process.env) {
  let seen = false;
  for (const name of ENV_NAMES) {
    const raw = env[name];
    if (!raw) continue;
    seen = true;
    const code = resolve(raw);
    if (code) return { code, seen: true };
  }
  return { code: null, seen };
}

function fromEnv(env = process.env) {
  return envLocale(env).code;
}

// Системная локаль Node. small-icu обычно отдаёт en-US — это допустимо:
// язык всё равно поддерживается, а при полном отсутствии подсказок остаётся ru.
function systemLocale() {
  const read = (ctor) => {
    try {
      return typeof Intl !== 'undefined' && ctor ? ctor().resolvedOptions().locale : null;
    } catch {
      return null;
    }
  };
  return read(Intl?.DateTimeFormat) || read(Intl?.Collator) || null;
}

// Авто-режим: env -> системная локаль -> ru. source фиксирует, что решило режим.
function pickAuto({ env = process.env, systemLocale: systemTag, source } = {}) {
  const envResult = envLocale(env);
  if (envResult.code) return { language: envResult.code, mode: AUTO, source: source || 'env' };
  // LANG=C / POSIX: локаль задана, но языкового предпочтения нет — ru.
  if (envResult.seen) return { language: DEFAULT, mode: AUTO, source: source || 'env' };
  const detected = resolve(systemTag === undefined ? systemLocale() : systemTag);
  if (detected) return { language: detected, mode: AUTO, source: source || 'system' };
  return { language: DEFAULT, mode: AUTO, source: source || 'default' };
}

// Определение языка вместе с режимом и источником. systemLocale — тестовый хук:
// реальная локаль машины не должна влиять на результат тестов.
function detectInfo({ lang, config, env = process.env, systemLocale: system } = {}) {
  if (lang !== undefined) {
    const mode = resolveMode(lang);
    if (mode === AUTO) return pickAuto({ env, systemLocale: system, source: 'lang' });
    if (mode) return { language: mode, mode: 'fixed', source: 'lang' };
    // Неизвестный явный код не блокирует загрузку: решает config/env (как раньше).
  }
  const configured = config && config.uiLanguage;
  const autoMode = configured === undefined || isAuto(configured);
  if (!autoMode) {
    const code = resolve(configured);
    if (code) return { language: code, mode: 'fixed', source: 'config' };
    // Некорректное значение в конфиге трактуем как auto, но конфиг не переписываем.
  }
  return pickAuto({ env, systemLocale: system });
}

function detect({ lang, config, env, systemLocale } = {}) {
  return detectInfo({ lang, config, env, systemLocale }).language;
}

// Сброс кэша каталогов (перечитать файлы; используется тестами и валидатором).
function clearCache() {
  cache.clear();
}

module.exports = {
  SUPPORTED,
  DEFAULT,
  AUTO,
  resolve,
  resolveMode,
  isAuto,
  load,
  setLanguage,
  getLanguage,
  t,
  has,
  languages,
  label,
  fromEnv,
  envLocale,
  systemLocale,
  detectInfo,
  detect,
  format,
  clearCache,
};
