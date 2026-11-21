# Changelog

Все заметные изменения проекта. Формат основан на
[Keep a Changelog](https://keepachangelog.com/ru/1.1.0/), версии — по
[Semantic Versioning](https://semver.org/lang/ru/). Незавершённые изменения
собираются в секции `Unreleased`, при выпуске она получает номер версии и дату.

## [Unreleased]

### Добавлено
- **Диагностика `LoginFailed`**: известные коды входа теперь печатают, что делать, а не
  только число. Для `error=8` (блок лицензии не от этой сборки) в лог уходит подсказка
  про `client-license.bin` и `docs/APK-UPDATE.md`; при расхождении версий сервера и
  клиента выводится `LoginFailed version mismatch: server expects X, this client sends Y`.
  3 теста в `tests/login-failed.test.js`.

## [0.3.4] — 2026-11-21

### Добавлено
- **Brawler по имени**: `team-brawler --brawler Gunslinger` (или `16:N`, или число) —
  имя ищется в `data/brawlers.json` без учёта регистра, неизвестное — с подсказками.
- **HomeRegion по якорю**: страна и хост в HomeData читаются строго за уникальной
  16-байтовой подписью (`+16`), а не побайтовым сканом. Скан оставлен фолбэком с
  лимитом 64 кандидата; результат содержит `method: 'anchor'|'scan'`.
  Живые фикстуры: `tests/fixtures/home-region-live-{kz,us}.bin`, 13 тестов.
- **Connect**: код `CONNECT_NOT_LINKED` отделён от `CONNECT_UNSUPPORTED`; на живом
  upstream `/games/unbind` отсутствует (404 как у несуществующего маршрута, в отличие от
  `/games/bind` с 403 «not authenticated») — таблица фактических ответов в `docs/CONNECT.md`.

### Изменено
- **Сборка**: из бандла исключены `docs/native/` и документация, которую не читает
  рантайм; входят только `docs/features.json`, `docs/protocol-evidence.json`,
  `docs/TUI.md`, `docs/COMMANDS.md`. `tests/` **остаются** — `node Nulls.js --test`
  работает из одного файла.
  `Nulls.js`: 1 127 018 → 812 952 Б (−28 %), zip: 729 953 → 498 274 Б (−32 %).
- `team-brawler`: живые пробы в лобби из двух аккаунтов (4 лобби, перебор 145 id)
  показали, что сервер разбирает 14375 (8-байтовый payload не рвёт соединение), но
  `brawler` в TeamData не меняет и ответ не присылает. Статус остаётся `experimental`;
  отрицательный случай подтверждён: одинаковые бойцы → `24129` код 17.

### Проверено
- `npm test` — 283 теста; `node Nulls.js --test` из собранного файла — 281 тест,
  278 pass, 3 skip; `npm run lint`, `prettier --check`, `bundle:check`, `--self-test`.
- Живой сервер: 14375 принят молча, 14355 при одинаковых бойцах → 24129/17,
  24124 приходит на `team-status`; `/games/unbind` отсутствует на upstream.


## [0.3.3] — 2026-11-21

### Добавлено
- **`team-brawler`**: выбор бойца в лобби — пакет **14375** (`int32 slot` + `int32` числовой id
  бойца), восстановлен по libg (`encode 0xf35ba8`, отправка из колбэка выбора `0x9c3864`).
  Команда помечена экспериментальной: раскладка подтверждена бинарём, но живой сервер на
  пробу не ответил — подробности и все попытки в `docs/REQUESTS.md` и
  `docs/native/team-brawler-native.txt`.
- **Nulls Connect**: `unbind` (`GET /games/unbind`, POST-fallback, `CONNECT_UNSUPPORTED` если
  upstream не поддерживает), `--connect-bind` для `login`/`create-account` (необязательный
  шаг: без bind-токена или bearer пропускается, вход не ломается), `links --json` и
  единая проверка всех `--json`-форм.
- **RTT**: `client.rttMs` / `rttSamples` из пары «запрос → совпавший ответ» (окно 50),
  `slot.rttMs`, `metrics.avgRttMs` и `metrics.rttSamples` в статусе флота.
- `docs/native/team-brawler-factory.md`, `docs/native/team-brawler-callsites.md` — разбор
  фабрики сообщений и call-site'ов из libg.

### Изменено
- `tools/fleet.js`/`watch`: `avgRttMs` рисуется, `0 мс` — валидный замер.
- `docs/COMMANDS.md`: разделы про `--connect-bind`, `unbind`, `watch`, `--json`/`--quiet`.
- `tests/session-fleet.test.js`: проверка `team-brawler` переведена с исключения на
  эталонные байты 14375.

### Проверено
- `npm test` — 261+ тест, `npm run lint` (eslint 0 ошибок), `prettier --check`,
  `node Nulls.js --self-test`, `bundle:check`.
- Живой сервер: 14375 принят молча (ни ошибки, ни обновления TeamData), 14354/14357/14364/14369
  рвут соединение; регион и Connect-bind проверены ранее.

## [0.3.2] — 2026-11-21

### Исправлено
- **Регион аккаунта работает**: `create-account --region KZ` применяет страну при
  регистрации, `account-region` меняет её у существующего аккаунта. Подтверждение идёт
  по ответу `24178` и по стране в HomeData (`lib/HomeRegion.js`), а не по
  `LoginOk.countryCode` — там гео по IP, оно остаётся `RU`. Формат запроса не менялся:
  `12998` — это `DataReference` класса 14, проверено дизассемблером и четырьмя живыми
  гостями (KZ, US, KE).
- `lib/Fleet.js`: `slot.joined` сравнивался с функцией `Protocol.target` вместо реальной
  цели — всегда был `false` после входа в клуб.
- `failedTotal` во флоте считал один сбой 2–3 раза; теперь единственная точка смены
  статуса (`setStatus`) и один инкремент на инцидент.
- `tools/watch.js`: `--bots` не работал из-за двойной нормализации; `--once` без
  значения вешал цикл, а `--once --json` съедал флаг; `avgLoginMs: 0` считался
  «нет данных».
- `lib/Accounts.js`: `upsert` больше не делает полный синхронный скан аккаунтов в
  обработчике события; отложенная запись реестра сохраняется при остановке флота.
- `lib/Fleet.js`: `readdirSync` каталога команд без `try` и потеря результата при
  удалённом `.runtime/commands`.

### Добавлено
- `node Program.js watch` — живой дашборд флота (`fleet-status.json`, `fleet.pid`,
  `fleet.log`, реестр, последние результаты команд): `--once`, `--interval`,
  `--log-lines`, `--bots first:count`, `--no-color`, `--json`. `docs/WATCH.md`.
- Глобальные `--json` / `--quiet` / `--json=false` для любой команды; ошибки в stderr
  JSON, коды выхода 1/2.
- Реестр аккаунтов: `lib/Accounts.js`, `accounts/index.json` (`0600`, без токенов),
  `tools/accounts.js` (`list`, `show`, `refresh`, `prune`, `stats`, `cleanup`),
  `docs/ACCOUNTS.md`.
- Метрики флота в `fleet-status.json`: `uptimeSec`, `loggedInTotal`, `failedTotal`,
  `avgLoginMs`, `p95LoginMs`, счётчики команд, `lastCommandAt`.
- Ротация `fleet.log` (5 МБ × 3, `--log-max-bytes`, `--log-keep`) и очистка `.runtime`
  (results старше часа, зависшие `.processing`, `*.tmp-*` и `*.lock` старше суток).
- Контракт ошибок: `lib/Errors.js` (`AppError`, `code`, `kind`, `retryable`, `details`,
  `toJSON` с маскировкой секретов), внедрён в Store, Accounts, Connect, Protocol,
  Actions, Client, Fleet, CLI, AccountLock, Platform, ProxyConnect, NullsLicense;
  `docs/ERRORS.md`.
- Точная раскладка хвоста `LoginOk`: `VInt tokenBlobMode` + `i32 tokenBlobLength` +
  blob (`u32 LE tokenRawLength` + zlib-JWT). Подтверждено декодером libg и восемью
  живыми входами; «VInt 1365/1366» был артефактом чтения со сдвигом.
- eslint 9 в `devDependencies`, `npm run lint` = `eslint .`; сборка кладёт в бандл
  только production-зависимости из `package-lock.json` (1250 файлов dev-дерева
  исключено; без фильтра `Nulls.js` был бы ~12,6 МБ).
- Тесты: `tests/account-region.test.js`, `tests/errors.test.js`,
  `tests/errors-integration.test.js`, `tests/packaging.test.js`,
  `tests/integration-{cli,fleet,login}.test.js`, дополнены fleet/accounts/watch/tui/i18n.

### Удалено
- `TcpSocket/Connection.js` — мёртвая обёртка без единого `require`.
- `docs/test-results.json` — устаревший снимок 0.2.7.

### Проверено
- `npm test`, `npm run lint` (eslint 0 ошибок), `prettier --check .`,
  `node Nulls.js --self-test`, `python3 tools/package_release.py --check`.
- Живой сервер: регион KZ/US/KE на новых гостях, bind-token в `LoginOk`, вход с
  привязкой Connect.

## [0.3.1] — 2026-11-21

### Добавлено
- Авто-выбор языка интерфейса: `uiLanguage: "auto"` в `config.json`, определение по
  `NULLS_LANG` / `LC_ALL` / `LC_MESSAGES` / `LANG`, затем по системной локали Node
  (`Intl`), потом `ru`. `node Program.js lang` показывает язык, режим и источник,
  `node Program.js lang auto` возвращает авто-режим, `lang <код>` фиксирует язык;
  в `info` добавлены `languageMode` и `languageSource`.
- TUI: управление в vim-стиле (`j`/`k`, `g`/`G`), `tab`/`shift+tab` по 10 пунктов,
  набор номера пункта цифрами с подтверждением по `enter`, `backspace` для сброса,
  справка по `?`, обрезка строк по ширине терминала с учётом CJK.
- Точная раскладка `LoginOk` 69.252 (`nulls-69`): плоские 32-битные id и строки,
  bind-token Nulls Connect лежит в zlib-потоке в конце пакета. Снято с живого
  сервера, закреплено обезличенными фикстурами `tests/fixtures/login-ok-69*.bin` и
  `tests/login-ok.test.js`; таблица смещений — в `docs/CONNECT.md` и `PROTOCOL-MAP.md`.
- `utils/Platform.js`: `isAndroid/isWindows/isMac/isLinux`, `pythonCommand`,
  `wakeLock`, `supportsApkUpdate`, `fileModeSecure`; `docs/PLATFORMS.md` — что работает
  на Windows, Linux, macOS и Android.
- `docs/FLEET.md` — контракт `fleet-status.json`, команды, лимиты и состояния.

### Изменено
- `lib/Fleet.js` оптимизирован: статус пишется не чаще 2 раз в секунду с heartbeat
  раз в 30 с и пропуском неизменившегося содержимого (было — запись на каждое
  изменение состояния каждого бота); очередь запуска на курсорах вместо двух полных
  поисков; `command --all` выполняет действия параллельно (`commandConcurrency`, по
  умолчанию 8) с сохранением порядка результатов; команды захватываются через
  `rename` в `.processing`, зависшие файлы чистятся через 10 минут; `stop()` делает
  финальный flush.
- `tools/fleet.js`: wake-lock только на Android через `Platform`, права на PID-файл
  через `fileModeSecure`, понятное сообщение при чужом процессе.
- `utils/AutoUpdate.js`: Python ищется как `python3` или `python`, APK-путь под
  платформенным гейтом, `path.sep` вместо `/`, обработка `SIGBREAK` на Windows.
- `tests/connect.test.js` учитывает третий фолбэк раскладки (`nulls-69`).

### Проверено
- `npm test`: 132/132, `node tools/i18n-check.js`: 248 ключей, `node Nulls.js --self-test`.
- Два живых `LoginOk` 69.252: раскладка разбирается полностью, bind-token находится,
  `pid` в claims совпадает с `accountId.lo`; живой вход сохраняет `bindToken` в аккаунт.
- 100 изменений состояния флота → 2 записи статуса за 2 с; `command --all` по 20 ботам
  за 169 мс вместо ~1000 мс.

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
- Сборка релиза воспроизводима: `npm run bundle` больше не включает
  `node_modules/.package-lock.json` и npm-кэши, а zip собирается с фиксированными
  отметками времени, поэтому архив получается байт-в-байт. Бандл сверяется по
  хешу содержимого: сам gzip-поток зависит от версии zlib и может отличаться
  между ARM и x64 при идентичных исходниках.
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