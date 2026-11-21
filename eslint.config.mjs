// Плоский конфиг ESLint (flat config) для проекта на CommonJS / Node 20+.
// Плагины не используются: только встроенные правила ESLint и пакет `globals`.
// Запуск: `npm run lint` (eslint .).

import globals from 'globals';

/** Файлы, которые не проверяем: сборка, шаблон бандла, фикстуры тестов. */
const IGNORED = [
  'node_modules/**',
  'Nulls.js',
  'tools/single-file.template',
  'tests/fixtures/**',
  'data/**',
  'docs/**',
  '.runtime/**',
  'accounts/**',
  'PacketsDumps/**',
  '.verification/**',
  '.updates/**',
  '.updates-*/**',
  '.nulls-single-*/**',
];

/** Общие для Node.js глобалы проекта; `Debugger` объявляется в utils/Debugger.js. */
const NODE_GLOBALS = {
  ...globals.node,
  // `self` используется вендорным портом TweetNaCl для доступа к WebCrypto.
  self: 'readonly',
  Debugger: 'readonly',
};

export default [
  { ignores: IGNORED },
  {
    files: ['**/*.js', '**/*.cjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: NODE_GLOBALS,
    },
    rules: {
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
      'no-undef': 'error',
      'no-var': 'error',
      'prefer-const': 'warn',
      eqeqeq: ['warn', 'smart'],
      'no-throw-literal': 'error',
      // Пустой `catch {}` в проекте встречается как осознанная best-effort очистка
      // (закрытие сокета, таймеры) в файлах вне текущей правки; блоки по-прежнему ловим.
      'no-empty': ['warn', { allowEmptyCatch: false }],
      'no-cond-assign': 'error',
      'no-self-assign': 'error',
      'no-unreachable': 'error',
      'no-dupe-keys': 'error',
      'no-redeclare': 'error',
    },
  },
  {
    // Сам конфиг — ESM, его проверяем как модуль.
    files: ['**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: globals.node,
    },
    rules: {
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
      'no-undef': 'error',
      'no-var': 'error',
      'prefer-const': 'warn',
      eqeqeq: ['warn', 'smart'],
    },
  },
  {
    // Вендорный порт TweetNaCl (public domain, 2014): стиль `var` сохраняем как есть.
    files: ['Crypto/NaClNative19.js'],
    rules: {
      'no-var': 'warn',
    },
  },
];
