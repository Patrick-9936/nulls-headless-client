# Ревью итерации: реестр аккаунтов, `watch`, метрики флота, eslint/бандл

Дата: 21 ноября 2026. Объём: незакоммиченный дифф (`git diff`, 23 изменённых + 9 новых файлов,
+2092/−165) плюс целиком ключевые файлы `lib/Fleet.js`, `lib/Accounts.js`, `tools/fleet.js`,
`tools/watch.js`, `tools/accounts.js`, `lib/CLI.js`, `lib/Store.js`, `lib/Client.js`,
`lib/Args.js`, `tools/package_release.py`.
Проверки: `node --test tests/*.test.js` → `tests 208 / pass 207 / fail 0 / skipped 1` (на момент
первого прогона, до появления параллельных правок `lib/Errors.js`, было `168 / 167 / 0 / 1`);
`node --check` по всем новым и изменённым JS — чисто; `npx eslint .` → `0 errors, 152 warnings`.

Отдельный раздел ниже — свежие правки других агентов (`lib/Errors.js`, `lib/HomeRegion.js`,
`lib/Store.js`), появившиеся во время ревью.

Находок: **1 blocker, 7 major, 12 minor, 3 nit.**

---

## Blocker

| # | Файл:строка | Что не так | Почему важно | Как исправить | Как проверить |
|---|---|---|---|---|---|
| B1 | `tools/watch.js:194`, `tools/watch.js:466+470`, `:466+503` | `run()` нормализует опции (`bots: '2:2'` → `{first,last}`), а затем передаёт **уже нормализованный** объект в `collectFrame()`, который снова вызывает `normalizeOptions()`. `parseBotsFilter()` принимает только строку → второго прохода объект превращается в `null`. | Фильтр `--bots` (задокументирован в `docs/WATCH.md`, флаг в таблице) **не работает ни в одном режиме**: ни в живом, ни в `--once`, ни в `--json`. Дашборд молча показывает всех ботов — на 100 ботах это нечитаемый экран и ложное впечатление, что фильтр применён. | Нормализовать один раз: `collectFrame({ options: options })` и внутри `collectFrame` не вызывать `normalizeOptions` повторно, либо сделать `normalizeOptions` идемпотентной (`if (typeof options.bots === 'object') keep`). | `node -e "console.log(require('./tools/watch').normalizeOptions(require('./tools/watch').normalizeOptions({bots:'2:2'})))"` → `bots: null`. Живой прогон с 3 ботами и `options:{bots:'2:2'}` печатает все 3 строки таблицы. |

Воспроизведение B1 на временном корне (3 бота, `bots: '2:2'`, `once: true`) выводит
`онлайн 3 из 3` и три строки таблицы вместо одной — подтверждено вживую.

---

## Major

| # | Файл:строка | Что не так | Почему важно | Как исправить | Как проверить |
|---|---|---|---|---|---|
| M1 | `lib/Fleet.js:304` | `slot.joined = Actions.same(client.club, target);` — в `same()` передаётся **функция** `Protocol.target`, а не тег. Строкой выше используется корректный `target(this.options.clubTag)`. | `same(a,b)` сравнивает `a.hi === b.hi`; у функции `.hi` нет → всегда `false`. В режиме `--club-tag` поле `joined` в `fleet-status.json` и в дашборде постоянно `false`, хотя бот в клубе. Пользователь видит «не вступил» и запускает `join-club` повторно. Дефект не из этого диффа, но живёт в ревьюируемом файле. | `slot.joined = Actions.same(client.club, target(this.options.clubTag));` — как в строке 302. | Юнит-тест: Fleet с `clubTag`, фейковый клиент с `club = Protocol.target('#TAG')`, после `join()` ожидать `slot.joined === true`. |
| M2 | `lib/Fleet.js:265`, `:291`, `:328` | `failedTotal` инкрементится в трёх независимых местах: в обработчике `state`, в таймере 90 с и в `catch` запуска. Один и тот же сбой засчитывается 2–3 раза (клиент эмитит `state:'failed'`, затем `close()` → `state:'stopped'`, затем `catch` добавляет ещё один). | Метрика `failedTotal` документирована в `docs/FLEET.md` как «переходов в failed/blocked» и выводится в дашборд. Завышение в 2–3 раза делает её бесполезной для оценки стабильности флота. | Считать только переходы статуса слота в одном месте: в обработчике `state` по `previous !== state`, а из таймера и `catch` убрать прямое `failedTotal++` (пусть статус ставится через `slot.status`, а инкремент живёт в одном хелпере `setStatus(slot, state)`). | Тест: фейковый клиент, `connect()` которого реджектит после `emit('state',{state:'failed'})`; ожидать `metrics.failedTotal === 1`. Сейчас будет 2. |
| M3 | `tools/watch.js:492-513` | Собственный `parseArgv` для флагов без значения берёт `argv[++i]`. Для `--once`/`--json` это лишний аргумент: `["--once"]` → `options.once === undefined`, `["--once","--json"]` → `options.once === "--json"` и `--json` съеден. Флаги распознаются только при наличии `=`. | Прямой `node tools/watch.js --once` (файл специально сделан запускаемым, `require.main === module`) не завершается — крутит дашборд вечно, а в CI/скриптах это зависание. `node tools/watch.js --once --json` ещё и теряет JSON-режим. | Для глобальных флагов (`json`, `quiet`, `no-color`, `once`) обрабатывать их до общего разбора, как `lib/CLI.js#splitGlobals`, а не через `argv[++i]`. | `node -e "console.log(JSON.stringify(require('./tools/watch').parseArgv(['--once'])))"` → `{"options":{}}`. Ожидается `once: true`. |
| M4 | `lib/Accounts.js:238-270` (`upsert`), `:219-236` (`flushPending`), `lib/Fleet.js:296` | `upsert()` при истёкшем 5-секундном окне вызывает `flushPending()` → `read(root)` → при устаревшем индексе `refresh()` → **полный синхронный скан всех `accounts/*.json` + запись `index.json`**. Всё это в обработчике события `account` клиента. | При 100 ботах и массовом реконнекте это 100 × (чтение 100 файлов) синхронного `readFileSync/statSync` в одном event loop — заметные паузы сокетов и TUI, ровно та деградация, от которой уходили в 0.3.1. `docs/ACCOUNTS.md` при этом утверждает: «Флот не пересобирает реестр на каждый вход». | Развести чтение и запись: `upsert` не должен вызывать `read()` (полный скан) — писать поверх загруженного в память реестра (`state.cache`), а `read` с пересборкой оставить для CLI. Либо переносить `flushPending` на `setImmediate`. | Лог-подсчёт вызовов `Accounts.scan` при 20 `upsert` с интервалом > 5 с: сейчас ≥ 20 полных сканов, должно быть 0. |
| M5 | `tools/watch.js:159-172`, `:296-317` | Каждый кадр (`--interval 1000`) синхронно: `tailLines` читает до 256 КБ `fleet.log`, `commandFailures` делает `readdirSync` + `statSync` и парсит до 50 JSON из `.runtime/results`, `readJson` — `fleet-status.json` и `index.json`. Всё в главном потоке. | На Termux/Android чтение 256 КБ + 50 файлов раз в секунду заметно нагружает I/O и подвешивает отрисовку; при `--interval 100` — гарантированные лаги. | Кэшировать по mtime: читать `fleet.log` и `results/` только если изменился `mtime` корневых каталогов/файлов; для `--json`/`--once` хватает одного прохода, но в цикле нужен кэш. | Замер: `--interval 100` на каталоге с 50 файлами результатов — время кадра растёт линейно; после кэша — константа. |
| M6 | `lib/Accounts.js:251-262`, `tools/fleet.js:220-228` | Отложенная запись реестра живёт на `setTimeout(..., 5000).unref()`, а `stop()` в `tools/fleet.js` вызывает `log.close()` и не делает финальный flush реестра. | При `SIGTERM`/`SIGINT` в пределах 5 с после входа бота ники, теги и клуб последнего бота не попадут в `index.json`. Индекс восстановится только через `read()` (до 60 с показа устаревших данных в `watch`/`accounts list`). | Добавить `Accounts.flush(root)` (синхронный `flushPending`) и вызывать его в `Fleet.stop()` и в `stop()` `tools/fleet.js`. | Тест: `upsert` → сразу `fleet.stop()` → `index.json` содержит обновлённую запись. Сейчас — старую или отсутствует. |
| M7 | `lib/Fleet.js:343` | `fs.readdirSync(this.commandDir)` в `processCommands()` не обёрнут в `try`. Каталог создаётся в конструкторе, но `Accounts.cleanup`/ручное удаление `.runtime`, смена прав или Windows-лок могут его убрать. | Исключение уходит в `.catch(console.error)` из `setInterval` — каждую секунду строка в лог, команды не обрабатываются, флот «жив», но мёртв по управлению. Пользователь видит только спам. | Обернуть в `try/catch` и на `ENOENT` пересоздавать каталог (`fs.mkdirSync(..., {recursive:true})`), остальные ошибки — `Debugger.error` один раз. | Тест: `fs.rmSync(fleet.commandDir, {recursive:true})`, вызвать `processCommands()`, ожидать восстановление каталога и отсутствие reject. |

---

## Minor

| # | Файл:строка | Что не так | Почему важно | Как исправить | Как проверить |
|---|---|---|---|---|---|
| m1 | `package.json:31` | `npm run check` перечисляет файлы руками; новые `lib/Accounts.js`, `tools/watch.js`, `tools/accounts.js` в список не добавлены. | `node --check` для трёх новых файлов не выполняется ни в `check`, ни в CI отдельно (eslint ловит синтаксис, но `check` — заявленный «синтаксис ключевых файлов»). | Добавить три файла в цепочку `node --check`. | `npm run check` + намеренная синтаксическая ошибка в `tools/watch.js` — сейчас не упадёт. |
| m2 | `docs/VERIFICATION.md:26`, `CONTRIBUTING.md:20` | Указано «`npm test` — 168 из 168» и «ожидается 168+ pass», фактически `tests 208 / pass 207 / skipped 1` (пропуск — тест бандла при отсутствии python). | Документация обещает число, которое никогда не сходится; проверяющий считает это регрессией. | Писать «208 тестов, 207 pass + 1 skip (условный)» и обновлять числа в PR, либо убрать конкретику из `CONTRIBUTING.md`. | `node --test tests/*.test.js 2>&1 \| tail -5`. |
| m3 | `CHANGELOG.md` | Нет секции `[Unreleased]`: реестр аккаунтов, `watch`, метрики `fleet-status.json`, ротация `fleet.log`, `lib/Accounts.js`, eslint-конфиг и `devDependencies` в диффе есть, а в changelog — нет. `CHANGELOG.md` вообще не изменён в этой итерации. | По `CONTRIBUTING.md` changelog — обязательная часть PR; тело релиза публикуется из него. | Добавить `## [Unreleased]` с пунктами по новой функциональности. | `grep -n Unreleased CHANGELOG.md` — пусто. |
| m4 | `tools/accounts.js:44-64` | Собственный `--json` печатает произвольный объект (pretty JSON), а `lib/CLI.js --json` — контракт `{ok:true,result}` / `{ok:false,error}`. Два разных «машинных» формата в одном проекте. | Внешние скрипты и `jq`-пайплайны не могут обрабатывать `accounts` и `Program.js` одним кодом. | Либо `accounts` через `lib/CLI.makeLogger`, либо задокументировать разницу в `docs/ACCOUNTS.md`. | Сравнить `node Program.js info --json` и `node tools/accounts.js list --json`. |
| m5 | `lib/Accounts.js:284-330` (`prune`), строка 323 | `.lock` удаляется, если базового файла нет (`!fs.existsSync(...)`). `Client` берёт `.lock` (`AccountLock.acquire`) **до** первого `save()` аккаунта — в этом окне `bot-N.json` ещё не существует, и `prune` сочтёт лок осиротевшим. | Два процесса смогут войти одним аккаунтом — риск бана и рассинхрона аккаунта. | Не удалять `.lock` моложе N минут (например 10) даже без базового файла. | Тест: создать только `bot-7.json.lock` со свежим mtime → `prune` не должен его тронуть. |
| m6 | `lib/Accounts.js:389-410` (`cleanup`) | `.runtime/commands/*.json` (не `.processing`) не чистятся никогда. Команда, отправленная при остановленном флоте, копится вечно и будет выполнена при следующем старте — внезапно и с устаревшими аргументами. | Неожиданное исполнение старой команды (`join-club`, `spam`) после рестарта; мусор в `.runtime`. | Добавить в `cleanup` удаление `commands/*.json` старше, например, суток, с пометкой в `docs/FLEET.md`. | Создать старый `commands/<uuid>.json`, вызвать `Accounts.cleanup` → файл остаётся. |
| m7 | `lib/Accounts.js:238-270` (`upsert`) | `state.timer` не снимается в `prune`/`cleanup`/`stop` и не имеет финального `flush` — см. M6; кроме того `state.entries.clear()` стоит **до** `try` в `flushPending`, поэтому исключение в `Store.write` теряет накопленные записи без повтора. | При ошибке записи (диск, права) изменения молча пропадают, а `registryWarned` уже съел предупреждение. | Перенести `clear()` в `finally`/после успешной записи, при ошибке оставлять `entries` для следующей попытки. | Замокать `Store.write` на throw, вызвать `upsert` дважды → вторая попытка должна писать накопленное. |
| m8 | `lib/Fleet.js:128-141` | `metricsData()` → `pendingCommands()` делает `readdirSync` на **каждую** запись статуса (до 2 раз в секунду). | Дешёво, но это блокирующий I/O в цикле записи статуса, который сознательно оптимизировали в 0.3.1. | Считать `pending` в `processCommands` (там `readdirSync` уже есть) и хранить в `this.metrics`. | `pending` не меняется, а `readdirSync` вызывается каждые 500 мс. |
| m9 | `tools/fleet.js:209-215` | `start` запускает потомка с `stdio: 'ignore'`; ошибки, возникшие **до** `installTee` (исключение в `new FleetLog`, `rotateLog`, `Store.write` PID), не попадают никуда. | Диагностика «флот не стартует и молчит» — самый дорогой класс багов на Android. | Ставить `installTee` до `log.rotateIfNeeded()`, либо отдавать `child.stderr` в `fleet.log` через `stdio: ['ignore','pipe','pipe']`. | Сломать `fleet.log` (каталог вместо файла), `fleet start` → лог пуст. |
| m10 | `tools/watch.js:498-501`, `:505-509` | `advance()` выводит `\u001b[H\u001b[2J`/`\u001b[NA`, даже когда `stdout` не TTY (`node Program.js watch > out.txt`). | Файл забивается escape-последовательностями; `--no-color` их не убирает. | При `!process.stdout.isTTY` в цикле печатать кадр с разделителем, без ANSI. | `node Program.js watch --interval 100 > out.txt; head -c 100 out.txt` — начинается с `\u001b`. |
| m11 | `tools/package_release.py:56-68` | `production_packages()` исключает всё с `devOptional: true`. Сейчас таких записей 0, но npm помечает так опциональные production-пакеты (классика — `fsevents` на macOS), и они выпадут из бандла на соответствующей платформе. | Тихая потеря рантайм-зависимости при смене платформы сборки; `verify_zip` это не заметит, потому что сверяет только `top_level` из того же множества. | Считать принадлежность к prod по достижимости от `packages[""].dependencies`, а не по флагу `dev`/`devOptional`. | `node -e "const l=require('./package-lock.json');console.log(Object.entries(l.packages).filter(([k,v])=>v&&v.devOptional).length)"` — сейчас 0, логика хрупкая. |
| m12 | `lib/HomeRegion.js:3-21` (параллельная правка) | `countryAt` вызывается на **каждом** смещении буфера `HomeData` без якоря: подходит любая последовательность `u32=2` + две заглавные буквы + `u32` + строка с точкой. | Ложное срабатывание даёт неверную страну региона в `Actions` (`client.homeRegion.country`) без какого-либо признака ошибки — «тихо неправильно» хуже исключения. | Сканировать только известные смещения из `PROTOCOL-MAP`/фикстуры либо валидировать, что найденный хост совпадает с хостом региона аккаунта. | Прогнать живые `HomeData` 24101/24180 и сравнить `country` с `LoginOk.countryCode`; добавить негативную фикстуру со случайным `00 00 00 02 52 55`. |

---

## Nit (стилистика, не баги)

1. `lib/Accounts.js:12` — глобальная `pendingWrites: Map<root, state>` живёт между тестами и не очищается; в тестах с несколькими корнями остаются висячие таймеры.
2. `lib/Fleet.js:394-396` — `cleanupStale()` вызывается из `processCommands` каждую секунду (после `commandScanInterval`), делая `readdirSync` + `statSync` по каждому `.processing`; достаточно раз в 10 с.
3. `tools/watch.js:534` — `stop()` ссылается на `const timer`, объявленный ниже `tick()`; при исключении в первом `tick()` обработчик SIGINT упадёт с `ReferenceError` (TDZ) вместо очистки.

---

## Что проверить на живом сервере

1. **`--club-tag` + `joined`** (M1): запустить `fleet run --count 2 --club-tag '#TAG'` на живом сервере и посмотреть `fleet-status.json` → `bots[i].joined`. Ожидание `true`; при текущем коде будет `false` при реальном членстве. Это единственный способ поймать дефект — фейковый клуб в тестах его маскирует.
2. **`failedTotal`** (M2): один бот с заведомо неверным `passToken`; сравнить `metrics.failedTotal` с числом реальных неудачных попыток после 3 реконнектов.
3. **Реестр под нагрузкой** (M4/M6): 100 ботов, `concurrency 20`, замерить паузы между пакетами (`slot.lastServerAt`) в момент массового входа; затем `SIGTERM` сразу после входа и проверить, что `accounts/index.json` содержит свежие ники/теги.
4. **Ротация лога** (m9): `--log-max-bytes 1024 --log-keep 2`, разогнать вывод, убедиться, что `fleet.log.1/.2` появляются, а процесс не падает на Windows-семантике `rename`.
5. **`watch` в реальном Termux**: `--interval 200` на 50+ файлах `.runtime/results` — визуальные лаги и нагрузка (M5).
6. **`--json` контракт** (M3): `node Program.js watch --once --json` → один JSON-объект; `node tools/watch.js --once` → выход, а не вечный цикл.

## Чего в диффе не хватает

**Тесты.** Покрытие новой поверхности неполное, и два теста создают ложное чувство защищённости:

- `tests/watch.test.js:158` («фильтр `--bots` ограничивает таблицу») вызывает `collectFrame({options:{bots:'2:2'}})`, **минуя** `run()`, где живёт дефект B1 — тест зелёный при полностью нерабочем флаге.
- `tests/watch.test.js:96` («`--once`») передаёт `options:{once:true}` напрямую, минуя `parseArgv` — дефект M3 не ловится.
- `tests/fleet.test.js:257` проверяет `typeof metrics.avgLoginMs === 'number'`; при `Date.now() - started === 0` это `0` (тоже number), т.е. тест не отличает «замер сделан» от «замер пустой». Нужен `assert.ok(metrics.avgLoginMs >= 0)` плюс отдельный тест на `null`, когда входов не было.
- Нет теста на двойной инкремент `failedTotal` (M2), на потерю отложенной записи реестра при `stop()` (M6) и на восстановление после удалённого `.runtime/commands` (M7).
- Ни один тест не вызывает `tools/watch.js`/`tools/accounts.js` как процесс — собственная обвязка `parseArgv`/`main` не покрыта, поэтому M3 жив.

**Документация.**
- `CHANGELOG.md` — нет `[Unreleased]` для всей итерации.
- `docs/WATCH.md` описывает `--once`/`--json`, но не предупреждает, что прямой `tools/watch.js` парсит флаги иначе; после фикса — либо убрать `require.main` у `tools/watch.js`, либо добавить пример.
- `docs/FLEET.md` и `docs/ACCOUNTS.md` обещают «флот не пересобирает реестр на каждый вход», что не выполняется при истёкшем 60-секундном кэше (M4).
- `docs/ACCOUNTS.md` не описывает потерю отложенной записи при завершении процесса (M6) и не описывает поведение `--json` относительно контракта `{ok,result}` (m4).
- `CONTRIBUTING.md` и `docs/VERIFICATION.md` расходятся с фактическим числом тестов (m2).

---

## Параллельные правки во время ревью

Пока шло ревью, в рабочем дереве появились `lib/Errors.js`, `lib/HomeRegion.js`, изменены
`lib/Store.js`, `lib/Actions.js`, `lib/Client.js`, `lib/Connect.js`, `lib/Accounts.js` и добавлены
`tests/errors.test.js`, `tests/account-region.test.js`, `tests/integration-*.test.js`.

- Правки `lib/Store.js` закрывают ранее найденный дефект: `write()` теперь удаляет временный
  `.tmp-<pid>` в `catch` — это правильно, находка снята.
- `lib/Errors.js` — контракт ошибок: `message` сохраняется, поля добавляются. Совместимость внешних
  скриптов (`docs/SCRIPTS.md`: они печатают/сравнивают `error.message`) не ломается. Проверять
  глубже стоит после того, как автор допишет: сейчас параллельные файлы меняются в процессе.
- `lib/HomeRegion.js` — единственная содержательная находка (m12): скан по каждому смещению без
  якоря даёт тихо неверную страну при ложном срабатывании.
- `tests/fixtures/login-ok-69*.bin` изменены: обезличенные фикстуры `LoginOk`. Убедиться, что
  внутри нет реальных `passToken`/`bindToken` и `deviceId` (по `Changelog`/`docs/VERIFICATION.md`
  фикстуры обезличены — при ревью бинарный дифф не читался).