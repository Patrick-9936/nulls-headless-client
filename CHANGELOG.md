# Changelog

Все заметные изменения проекта. Формат основан на
[Keep a Changelog](https://keepachangelog.com/ru/1.1.0/), версии — по
[Semantic Versioning](https://semver.org/lang/ru/). Незавершённые изменения
собираются в секции `Unreleased`, при выпуске она получает номер версии и дату.

## [0.3.0] — 2026-11-21

### Добавлено
- `Nulls Connect`: `lib/Connect.js` — PIN на e-mail, bearer-токен, привязка игрового
  аккаунта через bind-token из `LoginOk`; `tools/connect.js` с командами `pin`, `confirm`,
  `bind`, `links`, `token`, `status`, `logout`; `docs/CONNECT.md`; 10 тестов на мок-`fetch`.
  Токен хранится в `.runtime/connect.json` с правами `0600`, в логи попадает только
  замаскированный e-mail.
- `LoginOkMessage` извлекает `bindToken`, а ошибки декодирования собирает в
  `decodeErrors` с одной строкой в лог вместо двух молчаливых `catch`.
- Локализация интерфейса: `lib/i18n.js` и каталоги `lib/locales/{ru,en,tr,zh}.json`
  (233 ключа), флаг `--lang`, команда `node Program.js lang [код]`, переключатель языка
  в TUI, `tools/i18n-check.js` для сверки каталогов, `tests/i18n.test.js`,
  `docs/I18N.md`. `locale` уходит в legacy-логин, `preferredLanguage` — только в
  modern, `uiLanguage` хранит выбор интерфейса.
- Контракт совместимости для внешних скриптов: `tests/compat-scripts.test.js`
  проверяет `lib/Args`, `lib/Client`, `lib/Actions`, `lib/Protocol`, `lib/Store`,
  `utils/TagCodec`, `utils/NullsLicense`, `utils/ProxyConnect` и
  `ModernClientHelloMessage` — то, на чём держатся скрипты из `/sdcard/nulls-tools`.
- `docs/ARCHITECTURE.md` — устройство репозитория, путь пакета, жизненный цикл сессии,
  как добавить команду или пакет; `docs/SCRIPTS.md` — что гарантируется внешним
  скриптам; `CONTRIBUTING.md` — окружение, стиль и требования к PR.
- `prettier`, `.editorconfig` и `eslint.config.mjs` в корне; скрипты `format`,
  `format:check`, `lint:eslint`.
- CI-матрица на Node 20, 22 и 24: `npm ci --ignore-scripts`, `npm test`,
  `npm run check`, `npm run lint`, `node Nulls.js --self-test`.
- Отдельная CI-задача `bundle`: `npm run bundle:check` и полная пересборка с
  `git diff --exit-code -- Nulls.js`, чтобы закоммиченный бандл не расходился
  с исходниками.
- Релизный workflow `.github/workflows/release.yml`: по тегу `v*` и вручную,
  прогоняет тесты и проверки, собирает zip и `Nulls.js`, проверяет контрольные
  суммы и публикует GitHub Release через `gh`, подставляя тело из `CHANGELOG.md`.
- `LICENSE` (MIT) с блоком NOTICE: проект неофициальный, права на игру и её
  ассеты принадлежат правообладателям, `client-license.bin` и данные APK под
  MIT не попадают.
- `docs/RELEASING.md` — порядок выпуска версии и откат релиза.
- `docs/APK-UPDATE.md` — обновление клиента под новый APK: поля `config.json`,
  блок лицензии, seed, инструменты и типовые ошибки.
- Метаданные в `package.json`: `engines.node >= 20`, `license`, `repository`,
  `homepage`, `bugs`, `keywords`, `author`; скрипты `lint`, `bundle`,
  `bundle:check`.
- В `.gitignore`: `dist/`, `release-notes.md`, `*.tmp-*`, `coverage/`,
  `.DS_Store`, `.idea/`, `.vscode/`, `.eslintcache`.

### Изменено
- Сборка релиза детерминирована: `npm run bundle` больше не включает
  `node_modules/.package-lock.json` и npm-кэши, поэтому одинаковые исходники
  дают одинаковый sha256 бандла. Zip тоже собирается с фиксированными
  отметками времени.
- `tools/package_release.py` получил режим `--check`: собирает zip и бандл во
  временную папку и сравнивает sha256 с закоммиченным `Nulls.js`, ничего не
  перезаписывая; при расхождении возвращает код 1 и печатает список
  отличающихся файлов.
- `CHANGELOG-0.2.7.md` переименован в `CHANGELOG.md` и стал полным журналом
  проекта.
- `README.md` переписан: таблица возможностей, три способа запуска, языки,
  Nulls Connect, контракт внешних скриптов, обновление по APK и индекс
  документации.
- `lib/CLI.js` берёт версию из `package.json` вместо константы, help и сообщения
  об ошибках переведены на каталоги локализации.
- `config.json`: добавлены `locale`, `uiLanguage`; `preferredLanguage` не менялся.
- `lib/CandidateLoop.js` и `utils/HomeAge.js` больше не глотают ошибки молча:
  причина уходит в `Debugger.warn`, ожидаемые ошибки перебора отфильтрованы.
- Весь JS отформатирован prettier (`printWidth` 120), `npm run lint` теперь
  запускает полный `npm run check`.

## [0.2.7] — 2026-11-18

### Добавлено
- `TUI.js` и `docs/TUI.md` в исходники: меню раньше было только внутри бандла.
- `Nulls.js` собирается в репозитории тем же `tools/package_release.py`, что и архив.

### Исправлено
- Вход: в выпуске блок лицензии `client-license.bin` на 595 байт из PR #1. С прежним блоком на 723 байта сервер отвечает `LoginFailed error=8`.

### Проверено
- `npm test`: 82/82, `npm run check`: чисто, `node Nulls.js --self-test`: ok, 331 файл.
- Живой вход на 69.252, Home, список друзей.

## [0.2.6] — предыдущий выпуск

### Добавлено
- Аккаунты, клубы, лобби и флот ботов в headless-клиенте.
- Скрипты `fleet`, `update`, `features` и проверки протокола в `tools/`.

### Проверено
- Живые проверки входа и списка друзей; условия и отказы сервера описаны в
  `docs/VERIFICATION.md`. Точные даты и полный список правок этого выпуска не
  сохранились в репозитории — он попал сюда только как точка отсчёта для 0.2.7.