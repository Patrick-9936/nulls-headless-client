// Плоский конфиг ESLint (flat config) для проекта на CommonJS / Node 20+.
// Внешние плагины не используются: только встроенные правила ESLint.
// Пакет eslint в package.json не добавлен намеренно — конфиг лежит и подхватится,
// когда eslint установят (локально или в CI): `npx eslint .`
// Импортов нет, чтобы конфиг можно было загрузить без установленных зависимостей.

/** Файлы, которые не проверяем: сборка, шаблон бандла, фикстуры тестов. */
const IGNORED = [
  'node_modules/**',
  'Nulls.js',
  'tools/single-file.template',
  'tests/fixtures/**',
  'accounts/**',
  '.runtime/**',
  'data/**',
  'PacketsDumps/**',
];

export default [
  { ignores: IGNORED },
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: {
        // Node.js
        process: 'readonly',
        Buffer: 'readonly',
        console: 'readonly',
        global: 'writable',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        queueMicrotask: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        module: 'writable',
        exports: 'writable',
        require: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        fetch: 'readonly',
        performance: 'readonly',
        structuredClone: 'readonly',
        // Глобал проекта: инициализируется в utils/Debugger.js и в lib/Client.js.
        // Модули, которые могут загрузиться раньше, обязаны иметь фолбэк на console.
        Debugger: 'readonly',
      },
    },
    rules: {
      // no-undef выключен: глобалы объявлены выше, а часть модулей использует
      // динамические поля, поэтому правило даёт ложные срабатывания без плагина globals.
      'no-undef': 'off',

      'no-unused-vars': ['warn', { args: 'none', ignoreRestSiblings: true }],
      eqeqeq: ['warn', 'always'],
      'no-var': 'error',
      'prefer-const': 'warn',
      'no-throw-literal': 'error',
      'no-empty': ['error', { allowEmptyCatch: false }],
      'no-cond-assign': 'error',
      'no-self-assign': 'error',
      'no-unreachable': 'error',
      'no-dupe-keys': 'error',
    },
  },
];
