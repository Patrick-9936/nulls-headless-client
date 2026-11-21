# Архитектура

Документ описывает, как устроен клиент снаружи и внутри: путь пакета по слоям, жизненный цикл сессии, где живёт состояние и как расширять проект. Это карта, а не пересказ кода — перед правкой слоя откройте соответствующий файл.

## 1. Слои и направление зависимостей

```
Program.js                      точка входа: CLI
  └── lib/CLI.js                разбор аргументов, диспетчеризация команд, dry-run
        ├── lib/Args.js         parse(argv) → {options, positional}
        ├── lib/Store.js        атомарное чтение/запись JSON
        ├── lib/Actions.js      команда → протокольное взаимодействие + подтверждение
        │     ├── lib/Protocol.js   команда → {id, payload, version}
        │     ├── lib/Decode.js     байты сервера → структуры
        │     └── lib/Client.js     сессия: сокет, ожидания, состояние
        └── lib/Client.js
              ├── Messaging/Messaging.js       кадрирование, крипто, диспетчер пакетов
              │     ├── Crypto/NullsCrypto.js  шифрование/дешифрование Native19
              │     └── Messaging/LogicLaserMessageFactory.js   id → класс сообщения
              └── DataStream/Queue.js          накопление входящих байтов
утils/                           крипто-хелперы, прокси, теги, лицензия, обновление
DataStream/ByteStream.js         единственный кодек: VInt, строки, ссылки, boolean-биты
```

Зависимости идут строго сверху вниз: `Actions` не знает о сокете, `Protocol` не знает о `Client`, `ByteStream` не знает ни о чём. Обратные импорты запрещены — они превращают слои в клубок.

## 2. Путь одного пакета

### Отправка (`Actions.execute` → байты)

1. `Actions.execute(client, command, args)` — валидация команды, ветка подтверждения. Для простых команд управление уходит в общий хвост функции.
2. `Protocol.encode(command, args)` → `encodeBody`:
   - выбирает id по таблице `switch (command)`;
   - пишет payload в `ByteStream` (`writeVInt`, `writeLong`, `writeRequiredString`, `writeDataReference`);
   - возвращает `{id, payload: s.getBytes(), version}`.
3. `Client.request(command, args, options)`:
   - проверяет `this.state === 'online'`;
   - заранее ставит `wait(types, check, errors, timeout)` — подписку на ответ;
   - вызывает `messaging.send(id, payload, version)`;
   - ждёт `waiter.promise`, затем возвращает `{command, confirmed: true, response: <id>}`.
4. `Messaging.send(type, payload, version)`:
   - `crypto.encrypt(type, payload)`;
   - заголовок 7 байт: `uint16BE type`, `uint24BE length`, `uint16BE version`;
   - `socket.write(header)`, `socket.write(encrypted)`.
5. Версия кадра: `clientHello` → 0, `login` → `config.loginHeaderVersion` (10), иначе `messageVersion()` (0, если `usePackedHeaderVersion` выключен).

### Приём (байты → `Client._packet`)

1. `socket.on('data')` → `queue.add(bytes)`. Предохранитель: очередь больше 16 МБ → сокет уничтожается с ошибкой.
2. `while (messaging.pendingJob()) messaging.update()` — пока в очереди есть целый кадр.
3. `Messaging.pendingJob()` — истина, если в очереди ≥ 7 байт и длина из заголовка помещается в оставшиеся данные.
4. `Messaging.update()`:
   - читает `type`, `length`, `version` из заголовка;
   - `queue.release(length + 7)`;
   - `crypto.decrypt(type, encrypted)` — ошибка дешифрования логируется и кадр пропускается;
   - `this.onPacket(type, payload)`.
5. `Client._packet(type, payload)` — большой диспетчер по id:
   - `Decode.*` превращает байты в объекты (`Decode.team`, `Decode.club`, `Decode.friends`, `Decode.matchmaking` …);
   - результат кладётся в поля клиента (`this.club`, `this.team`, `this.friends`, `this.clubStream`, …);
   - событие `packet` для подписчиков (`fleet`, TUI, тесты);
   - проход по `this.pending`: если id в `item.errors` — reject, если в `item.types` и `item.check(packet)` — resolve.
6. Сообщения, у которых есть класс, обрабатываются фабрикой: `LogicLaserMessageFactory(type, config)` → `message.decode()`, `message.process(messaging)`. Так работают `ServerHelloMessage` (запускает логин) и `HomeReadyMessage` (запускает `onHomeReady`).

## 3. Жизненный цикл сессии

Состояния `Client.state`, которые видны в `fleet-status.json` и в событиях `state`:

```
stopped → connecting → authenticating → setting-profile → online
                ↓            ↓                  ↓
           reconnecting  failed/blocked     failed/blocked
```

1. **`Client.connect()`** — ставит `AccountLock` на файл аккаунта (`account.json.lock`), создаёт `net.Socket`, `Queue`, `Messaging`, поднимает `deadline` (по умолчанию 60 с на весь вход).
2. **Прокси** — `Proxy.loadProxy(options.proxyFile)` или пул `loadPool(options.proxyPoolFile)`, затем `Proxy.connectSocket(socket, {host, port, proxy}, ready)`.
3. **`authenticating`** — в `ready` вызывается `messaging.sendPepperAuthentication()`: `ModernClientHelloMessage(config).encode()` → `clientHello`.
4. **`ServerHelloMessage.process`** → `messaging.sendPepperLogin()`:
   - для `cryptoMode: 'nulls-native19'` дополнительно строится SDK-challenge (`Crypto/AndroidChallengeBridge`) и передаётся в `crypto.setChallengeResponse`;
   - `LoginMessage`/`ModernLoginMessage` по `config.loginLayout` → пакет `login` с заголовком версии 10.
5. **`LoginOkMessage.process`** — заполняет `messaging.account` (`hi`, `lo`, `passToken`), `Client` сохраняет аккаунт через `Store.write`, статус → `setting-profile`.
6. **`HomeReadyMessage.process`** → `messaging.onHomeReady(payload)`:
   - `utils/HomeAge.js` разбирает состояние возраста (ключ 15) и сохраняет `account.serverAgeState`;
   - при необходимости отправляется ник (`14600`/`10212`) и ожидается подтверждение;
   - `Client` запоминает `this.home`, сбрасывает `failures`, `deadline`, статус → `online`, событие `online`.
7. **Онлайн** — `Messaging.onLoggedIn` включает keep-alive (`10108` каждые 5 секунд) и таймаут действия 15 секунд.
8. **Переподключение** — `socket.on('close')`: если `options.reconnect` или уже идёт цикл — `_schedule(1000 · 2^failures)` (максимум 32 с), иначе статус `failed` и освобождение блокировки. `Client.reconnect()` — явный перезаход (`stop-spectate`, смена ника, верификация возраста).
9. **Блокировка аккаунта** — `lib/AccountLock.js`: файл `<account>.lock` с `{pid, id}`, открывается `wx`/`0600`. Занятый живым процессом аккаунт → ошибка с подсказкой использовать `fleet command`. Устаревшая блокировка (процесса нет) снимается.
10. **Таймауты** — сокет `idleTimeout` 30 с (`socket.setTimeout`), весь вход `connectTimeout` 60 с, ожидание подтверждения команды по умолчанию 20 с (`Client.wait`), таймаут действия в `Messaging` 15 с, `Fleet` — 90 с на первый вход бота.

## 4. Где лежит состояние

| Путь | Что внутри | В git |
|---|---|---|
| `config.json` | хост, порт, версия клиента, `cryptoMode`, `packetIds`, размер APK, путь лицензии | да (без секретов) |
| `client-license.bin` | блок лицензии из APK, подмешивается в hello | да |
| `accounts/*.json` | `hi`, `lo`, `passToken`, ник, клуб, лобби | **нет** (`.gitignore`) |
| `account.json` | аккаунт по умолчанию, если не указан `--account` | нет |
| `*.lock` | `AccountLock` — pid и uuid владельца | нет |
| `.runtime/commands/*.json` | очередь команд `fleet command` | нет |
| `.runtime/results/*.json` | результаты этих команд | нет |
| `.runtime/udp-proxies.json` | проверенные SOCKS5 для UDP-канала боя (до 32) | нет |
| `.runtime/candidates/` | pid, `status.json`, `run.log`, аккаунты раннера кандидатов | нет |
| `.runtime/connect.json` | токен авторизации `tools/connect.js`, режим `0600` | нет |
| `working-proxies.json` | пул рабочих прокси от `proxy-watch` | нет |
| `fleet-status.json`, `fleet.log`, `fleet.pid` | снимок флота и лог | нет |
| `PacketsDumps/` | сырые и расшифрованные кадры при `--dump` | нет |

Запись JSON — только через `Store.write`: временный файл `<file>.tmp-<pid>`, затем `rename`, режим `0600`. Это даёт атомарность и не оставляет полузаписанных аккаунтов.

## 5. Как добавить новую команду

Порядок важен: сначала протокол, потом действие, потом интерфейс, потом тест и документация.

1. **`lib/Protocol.js` → `encodeBody`** — добавьте `case '<command>'`:
   ```js
   case 'my-command': id = 99999; s.writeVInt(integer(args.value, 'value')); break;
   ```
   Валидация — через `integer`, `text`, `target`, `reference`. Никаких «сырых» значений без проверки диапазона. `encode()` подставит `version` из `docs/protocol-evidence.json`.

2. **`lib/Actions.js` → `commands`** — имя команды обязано попасть в массив, иначе `execute` её отвергнет.

3. **`lib/Actions.js` → `execute`** — добавьте ветку, если нужна нестандартная логика (несколько пакетов, ожидание состояния, повторная проверка). Для простых случаев достаточно записи в таблицу `expected` в конце функции:
   ```js
   'my-command': [24312],
   ```
   плюс, при необходимости, условие в `check(packet)`.

4. **Подтверждение** — команда не считается выполненной, пока сервер не прислал ожидаемое состояние. `client.request` возвращает `confirmed: true` только после `check`. Если подтверждение невозможно, верните `confirmed: false` и `note` с объяснением — не выдавайте отправку за успех.

5. **`lib/CLI.js` → `help`** — команда попадает в список автоматически (`Actions.commands.join(', ')`). Для утилит (без сети) добавьте отдельную ветку в `main`.

6. **Тест** — `tests/<тема>.test.js` на `node:test`. Минимум: корректный payload, отказ на неверных аргументах, поведение `check` на фикстуре. Запуск одного файла: `node --test tests/<тема>.test.js`.

7. **Документация** — строка в `docs/COMMANDS.md` (команда, параметры, ожидаемый результат) и запись в `docs/features.json` (`command`, `status`, `experimental`). Статусы: `live-verified`, `native-recovered`, `experimental`. Неудачную команду не поднимайте до `live-verified`.

## 6. Как добавить новый пакет

1. **Класс-сообщение** — `Messaging/Messages/Client/MyMessage.js` (отправка) или `Messaging/Messages/Server/MyMessage.js` (приём). Контракт класса:
   - `constructor(config, account, …)`;
   - `this.ByteStream = new ByteStream(размер)`;
   - `encode()` для клиентских, `decode()` + `process(messaging)` для серверных.

2. **Регистрация id** — `config.json → packetIds.myMessage`. Имена кандидатов (когда сервер отвечает одним из нескольких id) — массивом, как `loginOkCandidates`.

3. **Фабрика** — `Messaging/LogicLaserMessageFactory.js`: `if (includesCandidate(type, p.myMessage, p.myMessageCandidates)) return new MyMessage();`. Серверные сообщения без класса обрабатываются прямо в `Client._packet` — так сделано для большинства ответов.

4. **Разбор** — если это не состояние, а данные, декодер живёт в `lib/Decode.js`. Правило: сначала проверка размера и границ, затем чтение; в конце — `if (s.remaining()) throw new Error('Лишние данные …')`, чтобы не принимать обрезанный кадр за валидный.

5. **Тест** — фикстура-байты в `tests/fixtures/` и тест на разбор: валидный кадр, обрезанный кадр, лишние байты. Каждый новый пакет без теста не принимается.

## 7. Правила проекта

- **Ошибки — значения или исключения на границе.** Внутри декодеров `throw` допустим и ожидаем: вызывающий (`Client._packet`) ловит и превращает в событие `warning`. Молчаливый `catch {}` в декодере запрещён — либо проброс, либо лог с причиной через `Debugger.warn`.
- **Ограничения на размеры.** Любой внешний буфер проверяется до аллокации: `home.length > 1024 * 1024`, `bytes.length > 2 * 1024 * 1024`, `count(s, maximum)`, `payload.length > 4096` в `BattleProtocol`. Число элементов из пакета никогда не используется как длина массива без верхней границы.
- **Никаких «доверенных» длин.** `readBytes`, `readString`, `readByteArray` уже проверяют `remaining()`; не обходите их прямым доступом к `payload`.
- **Идемпотентность состояния.** Поля клиента пересобираются на каждом `_startOpen`; обработчик пакета не должен зависеть от данных прошлой сессии.
- **API-совместимость.** Публичные контракты, на которые опираются внешние скрипты (`tools/`), описаны в [SCRIPTS.md](SCRIPTS.md). Их изменение без мажорной версии ломает чужие сценарии.
- **Тесты на каждый новый пакет и каждую новую команду.** `npm test` должен оставаться зелёным; падающий тест не «известная проблема», а регресс.
- **Секреты.** `accounts/*.json`, `client-license.bin` (в репозитории), `.runtime/connect.json` — не логировать, не печатать, не коммитить. Токен аккаунта в вывод попадать не должен.

## 8. Файл → ответственность

| Файл | Зона ответственности | Что нельзя ломать |
|---|---|---|
| `Program.js` | точка входа, проброс `main()` и кода возврата | контракт «ошибка → `exitCode = 1`» |
| `lib/CLI.js` | разбор команды, `help`, `--dry-run`, сборка `Client`, вывод JSON | список команд в `help`, dry-run без сети |
| `lib/Args.js` | `--key value`, `--flag`, массивы `--modifiers 1,2` | имена флагов и приведение `accept/familyFriendly/disabled` |
| `lib/Actions.js` | сценарий команды и подтверждение результата | `commands`, `experimental`, формат возвращаемого объекта |
| `lib/Protocol.js` | кодирование запросов, валидация аргументов | `id` и порядок полей в payload |
| `lib/Decode.js` | разбор ответов сервера | имена полей результата (`members`, `clubs`, `friends`) |
| `lib/Client.js` | сессия, сокет, ожидания, состояние, переподключение | имена состояний, события `state/packet/online/disconnected/warning` |
| `lib/Store.js` | атомарное чтение/запись JSON | сигнатура `read(file, fallback)` / `write(file, value)` |
| `lib/AccountLock.js` | эксклюзивный доступ к файлу аккаунта | формат `.lock` (`pid`, `id`) |
| `lib/Fleet.js` | пул сессий, очередь команд, снимок статуса | `fleet-status.json`, лимиты `count 1–100`, `concurrency 1–20` |
| `lib/CandidateRunner.js` | автономный прогон кандидатов, рост флота | `.runtime/candidates/status.json` |
| `lib/CandidateLoop.js` | выбор события и машина состояний боя | фазы `idle/queued/loading/battle/ended/…` |
| `lib/MatchmakingGate.js` | ограничение одновременных подборов | лимит `--max-queued` |
| `lib/BattleSession.js` | UDP-канал боя через SOCKS5 | события `packet/vision/warning/close` |
| `lib/BattleProtocol.js` | кадры боевого канала | границы `readArray`, состав connection |
| `lib/BrawlTV.js` | каналы и следующие трансляции | id 24700/24701 |
| `lib/ClubStream.js` | серверная лента клуба | типы записей и `entryId` |
| `lib/ProxySources.js` | загрузка и отбор публичных прокси | отсев приватных сетей и учётных данных |
| `Messaging/Messaging.js` | кадрирование, крипто, диспетчер, keep-alive | формат заголовка 7 байт, версии кадров |
| `Messaging/LogicLaserMessageFactory.js` | id → класс сообщения | обработку `loginOkCandidates`, `ownHomeCandidates` |
| `DataStream/ByteStream.js` | кодек примитивов | семантику `writeString` (-1) vs `writeRequiredString` (0) |
| `DataStream/Queue.js` | буфер входящих байтов | `size()`/`release()` — на них завязан `pendingJob` |
| `utils/Debugger.js` | глобальный `Debugger` (`warn/info/error/fatal`) | наличие глобала после `require` |
| `utils/ProxyConnect.js` | `parseProxy`, `connectSocket`, SOCKS5/HTTP CONNECT, UDP-ассоциация | `parseProxy` и `connectSocket` использует внешний код |
| `utils/TagCodec.js` | тег ↔ LogicLong | `logicLongToTag(hi, lo)`, `tagToLogicLong(tag)` |
| `utils/HomeAge.js` | состояние возраста из Home | возврат `{state, …}` или `null` |
| `utils/NullsLicense.js` | подмешивание лицензии APK в hello | `config.loginClientSeed`, `config.createHelloExtra` |
| `utils/TeamCode.js` | код комнаты ↔ LogicLong | алфавит и префикс `X` |
| `utils/AutoUpdate.js` | обновление конфигурации из APK | запись `config.json`, `--check`/`--watch` |
| `Crypto/NullsCrypto.js` | Native19 шифрование/дешифрование | `encrypt/decrypt`, установку ключа сессии |
| `TUI.js` | интерактивное меню | не часть headless-контракта |
| `Nulls.js` | собранный бандл | генерируется `tools/package_release.py`, руками не правится |

## 9. Сборка и проверки

`tools/package_release.py` — единственный источник zip-архива и однофайлового
`Nulls.js`; руками ни то, ни другое не правится.

- **Состав.** В бандл входят исходники из `DIRECTORIES`/`FILES`, `package.json`,
  `package-lock.json`, `config.json`, `docs/` и только production-зависимости
  (`blakejs`, `colors`, `tweetnacl` и их транзитивное дерево). Набор production-пакетов
  считается по `package-lock.json`: записи с `dev: true` / `devOptional` исключаются
  вместе со всем содержимым, `node_modules/.bin`, `.package-lock.json` и npm-кэши
  не попадают никогда. Поэтому `eslint`, `globals` и прочие devDependencies бандл
  не раздувают.
- **Детерминизм.** Файлы сортируются по POSIX-пути, gzip пишется с `mtime=0`,
  отметки времени и права в zip фиксированы. Одинаковые исходники дают одинаковый
  sha256 архива; содержимое `Nulls.js` сверяется по хешу распакованного payload,
  потому что gzip-поток зависит от версии zlib.
- **Режимы.** `npm run bundle` собирает zip рядом с клоном и `Nulls.js` в корень;
  `npm run bundle:check` собирает во `$TMPDIR` и сравнивает с закоммиченным
  `Nulls.js` (код 1 при расхождении). `node Nulls.js --self-test` проверяет
  целостность встроенных модулей.
- **Линтеры.** `npm run lint` — `eslint .` по плоскому конфигу
  `eslint.config.mjs` (CommonJS, `ecmaVersion: 2023`, без плагинов, только
  `globals`); `npm run format` / `npm run format:check` — prettier 3 с
  `.prettierrc.json` (`printWidth 120`). `npm run check` — отдельная быстрая
  проверка синтаксиса ключевых файлов и `node Program.js info`, она не заменяет
  eslint.
- **CI.** `.github/workflows/ci.yml` гоняет `npm ci --ignore-scripts`, `npm test`,
  `npm run check`, `npm run lint` и `node Nulls.js --self-test` на Node 20/22/24,
  отдельная задача `bundle` проверяет `bundle:check` и воспроизводимость zip.
  `release.yml` повторяет проверки, собирает артефакты и публикует GitHub Release.

## 10. Что читать дальше

- `docs/COMMANDS.md` — список команд и параметров.
- `docs/SCRIPTS.md` — контракт для внешних скриптов.
- `docs/VERIFICATION.md` — что подтверждено на живом сервере, а что нет.
- `docs/REQUESTS.md`, `docs/MATCHMAKING.md`, `docs/BRAWL_TV.md`, `docs/BATTLE_UDP.md` — детали подсистем.
- `docs/native/` — выписки из нативной библиотеки, на которых построены декодеры.