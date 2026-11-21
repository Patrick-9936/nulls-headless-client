# DESIGN-REVIEW: архитектура 0.3.1 + текущие правки

Срез: коммит `68b6979` (0.3.1) + незакоммиченные изменения в рабочем дереве.
Проверено: 95 JS-файлов вне `node_modules`/`.git`; `node --test tests/*.test.js` — 168 тестов, 167 pass, 1 skip (reproducible-zip/`python`), 0 fail, ~31 с.
Документ описывает только то, что видно в коде; спорные места помечены **(проверить)**.

---

## 1. Границы слоёв и зависимости

### 1.1 Фактическая схема require-связей

Циклов нет: обход 95 файлов по `require('./…')` даёт 0 циклических цепочек. Направление в целом совпадает с `docs/ARCHITECTURE.md`, но есть обходные пути и «вторые» слои.

```
Program.js
  └── lib/CLI.js ── Args, Store, Protocol, Actions, Client, i18n
        │            ├── (lazy) tools/watch.js
        │            ├── (lazy) utils/AutoUpdate.js
        │            └── (lazy) utils/TagCodec.js, utils/TeamCode
        ├── Actions ── Protocol, Decode, ByteStream
        │     └── (lazy) BrawlTV, Store(data/maps.json), TeamCode, data/regions.json
        ├── Client ── Messaging, Queue, ProxyConnect, Store, Decode, Protocol
        │     ├── (lazy) AccountLock, BrawlTV, BattleProtocol, BattleSession
        │     └── Messaging ── LogicLaserMessageFactory, Messages/*, Crypto/*
        │           └── (lazy) ClubProtocol, ByteStream, TeamCodec, NullsLicense
        └── Fleet ── Client, Actions, Store, Accounts, Protocol, TagCodec
              └── Accounts ── Store, TagCodec

TUI.js ── Client, Actions, Store, i18n, TagCodec, TeamCode + spawn(tools/fleet.js, tools/update.js)
tools/fleet.js ── Args, Store, Accounts, Platform, Fleet
tools/accounts.js ── Args, Accounts
tools/connect.js ── Args, Connect
tools/watch.js ── fs, i18n
tools/candidates.js ── Args, Store, CandidateRunner
tools/test-session.js ── Args, Store, CandidateRunner + spawn(candidates.js, proxy-watch.js)
tools/proxy-watch.js ── ProxyConnect, ProxySources, ModernClientHelloMessage, NullsLicense
lib/Connect.js ── Store, package.json
utils/AutoUpdate.js ── LibgInspector, UpdateTransport, Platform, (lazy) AccountLock, NullsLicense
```

### 1.2 Где границы нарушены

| Модуль | Что знает лишнего | Конкретно |
|---|---|---|
| `lib/Fleet.js` | Protocol, Actions, Accounts, TagCodec, Store | Валидирует аргументы через `Protocol.integer` (строки 36–47), форматирует тег через `TagCodec.logicLongToTag` (89, 277), вызывает `Actions.execute`/`Actions.same` (278, 303, 404), пишет реестр через `Accounts.upsert` (159). Оркестратор и слой представления слиты. |
| `lib/Client.js` | файловая система, конфиг, доменные декодеры | `Store.read/write` аккаунта и `config.json` (18, 21, 39, 86–89, 113), `save()` на каждый `24124/24125/24399` (263–267), ленивые `require('./BrawlTV')`, `BattleProtocol`, `BattleSession` внутри `_packet` (229–244). Сессия + персистентность + домен. |
| `Messaging/Messaging.js` | файловая система, глобальный `Debugger`, `process.exitCode`, второй набор энкодеров | `saveAccount()`/`saveConfig()` через `fs.writeFileSync` без `Store` (33–38); `PacketsDumps` (31, 67–78); `Debugger.*` и `process.exitCode` (45, 83, 132, 191, 220); `runAction()` (412–487) дублирует `Actions`/`Protocol` для `create-room/join-room/leave-room/chat/create-club/join-club/club-info/friend/spectate`. В production `Client` создаёт `action = {mode:'login'}` (Client.js:94), поэтому этот путь не используется; его гоняют только тесты `tests/profile-social.test.js`. Мёртвый параллельный командный слой. |
| `lib/CLI.js` | Protocol, tools, AutoUpdate | `Protocol.integer` для `room-code` (277), dry-run-таблица команд (304–325), ленивые `require('../tools/watch')` (198) и `AutoUpdate` (235). CLI — роутер, форматтер и владелец списка «сетевых/несетевых» команд. `Connect` CLI **не** импортирует: `Connect` живёт только в `tools/connect.js`. |
| `lib/Actions.js` | fleet-оркестрация | Ветки `team-*`, `invite-answer`, `player-status`, `club-request` читают `client.peers` и ждут события у **другого** клиента (136–149, 229–279, 288–310, 340–351, 507–523). Сценарий команды и координация нескольких сессий в одной функции. |
| `tools/watch.js` | формат чужих файлов | Читает `fleet-status.json`, `fleet.pid` + `/proc`, `accounts/index.json`, `.runtime/results/*`, `fleet.log` (49–143, 193–248). Комментарий «формат не фиксирован» (90) — признание, что API нет. Не может отличить «флот не пишет» от «флот пишет другое». |
| `TUI.js` | каталог команд + spawn CLI | Собственный `commands` (59–244) и `groups` (245–327), вызов `tools/fleet.js status`, `tools/update.js` через `spawn` (829–834, 841–861) вместо библиотечного API. |
| `lib/Connect.js` | путь состояния по умолчанию | `defaultStateFile()` читает env/`__dirname` при вызове (53–59), `BASE`/`PROFILES_BASE` фиксируются при загрузке модуля (37–38). Единственный модуль с нормальным `ConnectError` (40–47) — хороший образец, но конфигурация не инжектируется. |
| `utils/AutoUpdate.js` | второй «app»: свой lock, своя атомарная запись | `.updates/update.lock` (82–103), `atomicWrite` (62–66), `commit()` с проверкой «config не изменился» (67–81) — параллельный `Store.write` контур. |
| `utils/NullsLicense.js` | мутирует config, добавляет функцию | `config.createHelloExtra = () => …` (10–21). Функция молча исчезает при `JSON.stringify` в `Store.write`; поведение зависит от того, кто и когда применил `apply`. |

Мёртвый код и расхождения с документацией:

- `utils/Debugger.js` нигде не требуется (проверено grep по `require`), но описан в `docs/ARCHITECTURE.md` §8 как модуль с контрактом. Глобальный `Debugger` фактически ставится в `lib/Client.js:34`, `lib/CLI.js:43`, `tools/fleet.js:222`, `TUI.js:864`.
- `TcpSocket/` удалён в рабочем дереве, ссылок в коде нет.
- `Messaging.saveAccount`/`saveConfig` в production перекрываются (`Client.js:105,113`), но остаются как неатомарный fallback для любого прямого использования `Messaging`.

### 1.3 Направление зависимостей: желаемое vs фактическое

| Слой | Должен знать | Знает фактически | Вывод |
|---|---|---|---|
| Транспорт (`Messaging`, `Queue`, `Crypto`) | байты, сокет | файлы, глобальный логгер, `process.exitCode`, команды | нарушение |
| Протокол (`Protocol`, `Decode`) | байты ↔ структуры | `docs/protocol-evidence.json` (Protocol.js:281), `data/regions.json` (Actions) | код зависит от docs |
| Домен (`Client`) | сессия и состояние | Store/fs, конфиг, BrawlTV/Battle* | нарушение |
| Сценарии (`Actions`) | одна команда | peers, `Store`, `data/*`, `TeamCode` | частичное нарушение |
| Оркестрация (`Fleet`) | пул сессий | Protocol/Actions/Accounts/TagCodec | нарушение |
| Интерфейс (`CLI`, `TUI`, `tools/watch`) | ввод/вывод | файлы состояния, каталоги команд, spawn | нарушение (watch/TUI) |

---

## 2. Состояние и его владельцы

### 2.1 Карта файлов

| Путь | Писатели | Читатели | Риск |
|---|---|---|---|
| `config.json` | `CLI.saveConfig` (87–91), `Client` через `messaging.saveConfig` (113), `AutoUpdate.commit` (67–81), `TUI.saveLanguage` (633–637), внешние скрипты по `docs/SCRIPTS.md` | все | last-write-wins, 4 независимых писателя |
| `accounts/bot-N.json` | `Client.save()` (38–41) на login/team/club/name/age; `Messaging.saveAccount` fallback; пользователь | `Fleet` constructor (81), `Client` (21, 86), `Accounts.scan`, `tools/connect.js` (79) | запись на каждый `24124`; два процесса защищены только `AccountLock` |
| `accounts/index.json` | `Accounts.refresh` (142–146), `Accounts.upsert`→`flushPending` (200–215), `tools/accounts.js refresh` | `tools/accounts.js`, `tools/watch.js` (91–103), `Accounts.find` | производный, но `read()` сам пишет; RMW-гонки |
| `accounts/*.lock` | `AccountLock.acquire/release` | `AccountLock`, `Accounts.prune` | релиз падает на битом JSON |
| `.runtime/commands/*.json` | `tools/fleet.js` (179–180), внешние скрипты | `Fleet.processCommands` (343–392) | захват через `rename` — корректно в одном процессе |
| `.runtime/results/*.json` | `Fleet.processCommands` (381–385) | CLI (191), `watch.commandFailures` (111–143) | только строковый `error` |
| `.runtime/udp-proxies.json` | `Client._openBattle` (390–466) | `Client._openBattle` | read-modify-write без блокировки |
| `.runtime/connect.json` | `Connect.confirmPin` (285–290), `logout` | `Connect.tokenOf/status` | один писатель, 0600 |
| `.runtime/candidates/*` | `CandidateRunner.snapshot` (232–269), `tools/candidates.js` | `tools/candidates.js status`, тесты | не описано в `docs/ARCHITECTURE.md` §4 |
| `.runtime/test-session/*` | `tools/test-session.js` | `tools/test-session.js status` | свой pid/status |
| `fleet-status.json` | `Fleet.flushStatus` (182–199) | `tools/fleet.js status`, `watch.collectFrame` | снимок, не источник истины |
| `fleet.pid` | `tools/fleet.js run` (204) | `tools/fleet.js ownedPID`, `watch.fleetProcess` | `/proc`-проверка только на Linux/Android |
| `fleet.log` + `.1…N` | `tools/fleet.js` tee (103–111) | `watch.tailLines` | ротация только у флота |
| `working-proxies.json/.txt` | `tools/proxy-watch.js` `atomic()` (29–33, 243–246) | `Proxy.loadPool`, `proxy-watch` | дубль `Store.write`; `.txt` не чистится |
| `proxy-watch-status.json` | `tools/proxy-watch.js status()` (125–140) | CLI/скрипты | формат только здесь |
| `PacketsDumps/` | `Messaging.update` при `--dump` (67–78) | — | не чистится нигде |
| `.updates/backups/*.json` | `AutoUpdate.commit` (71–79) | `runUpdate --rollback` | не чистится (проверить: очистки в коде не найдено) |

### 2.2 Конкретные гонки и рассинхрон

1. **`config.json`: четыре писателя без ревизии.**
   `AutoUpdate.commit` проверяет только «файл не изменился с момента чтения» (69–70), а `Client` пишет конфиг при каждом сохранении (`Client.js:113`), `CLI` — при смене языка (87–91), `TUI` — при выборе языка (633–637). Правка `config.json` во время флота затрётся следующим `saveConfig`. `NullsLicense.apply` добавляет в объект функцию — при сериализации она исчезает, поэтому «применённость» лицензии зависит от порядка вызовов, а не от файла.

2. **`accounts/*.json`: запись на каждое обновление лобби.**
   `Client._packet` для `24124` (команда) и `24125` (выход) делает `this.save()` (263–271), то есть синхронную запись+`rename` на каждый пакет состояния команды. При 100 ботах в одном лобби это десятки записей в секунду на flash. `Fleet` читает аккаунты в конструкторе (78–90) до захвата `AccountLock`; два процесса, стартующие одновременно, прочитают одно и то же, а разойдутся только на `connect()`.

3. **`AccountLock`: два дефекта.**
   `release()` читает lock через `Store.read` (41) — если файл пуст/битый (падение между `open` и `write`), `JSON.parse` бросит исключение из `Client.close()`. `acquire()` при битом lock тоже падает с ошибкой парсинга вместо понятного сообщения (24). Захват не атомарен относительно удаления устаревшего lock: между `process.kill(pid,0)`→`ESRCH`→`unlink` два процесса могут оба решить, что lock мёртв **(проверить: окно узкое, но воспроизводимо при массовом старте)**.

4. **`accounts/index.json`: «свежесть» по количеству файлов.**
   `isStale` (135–139) проверяет возраст 60 с и **число** `*.json`. Переименование/замена файла с тем же количеством оставляет индекс с устаревшими `hi/lo/name/size`. `read()` при устаревании делает полный скан и **пишет** файл (149–165) — чтение имеет побочный эффект. `flushPending` (200–215) делает read-modify-write, а параллельный `tools/accounts.js refresh` или второй флот могут перетереть друг друга.

5. **`fleet-status.json` vs реальные клиенты.**
   Статус — снимок: пишется не чаще 2 раз/с и heartbeat раз в 30 с (`Fleet.js:11–16, 167–199`). `watch` считает флот живым по `fleet.pid`+`kill(0)`/`/proc` (49–67) и не сверяет `pid` из статуса с `pid` из `fleet.pid`. Поле `bots[]` — это живые объекты `this.slots` (108), а не копии: сериализация синхронна, поэтому безопасна, но любой внешний потребитель, импортирующий `Fleet` в процесс, получает мутируемые объекты.

6. **Баг: `slot.joined` всегда `false` после успешного join.**
   `lib/Fleet.js:304`: `slot.joined = Actions.same(client.club, target);` — здесь `target` — импортированная функция `Protocol.target` (строка 9), а не объект тега. `Actions.same` сравнивает `a.hi/b.hi`, у функции их нет → всегда `false`. На строке 278 то же сравнение сделано правильно: `target(this.options.clubTag)`. Тест `tests/fleet.test.js:71` передаёт `clubTag`, но проверяет только поле `status.clubTag` (91), не `joined`. Это видимый дефект статуса, а не только косметика: внешние скрипты по `joined` решают, в клубе ли бот.

7. **Результаты команд: «файл есть» ≠ «команда выполнена».**
   CLI ждёт появления `.runtime/results/<id>.json` (186–190) и не различает: флот умер до записи (ошибка «результат не получен»), команда упала (`ok:false,error:string`), команда выполнена частично (`ok:true,result:[{index,error}]`). В `result` нет ни кода ошибки, ни признака retryable, ни heartbeat/попытки.

8. **`udp-proxies.json` теряет обновления.**
   Два клиента, одновременно подтвердившие прокси, делают независимые `Store.read` → `Store.write` (`Client.js:430–437` и `456–466`); второй затрёт запись первого. Файл — кэш, поэтому потеря не критична, но поведение недетерминировано.

9. **`Store.write` не транзакционен между процессами.**
   Временный файл — `<file>.tmp-<pid>` (`Store.js:11`), `rename` атомарен, но read-modify-write у вызывающих нет ни версии, ни блокировки. Все «реестры» (`accounts/index.json`, `udp-proxies.json`, `config.json`) страдают одинаково.

10. **`.runtime` и логи растут неравномерно.**
    `fleet.log` ротируется, `proxy-watch.log` открывается на `a` без ротации (`proxy-watch.js:52`), `PacketsDumps/` не чистится, `.updates/backups` не чистится, `.runtime/results` чистит только `fleet run` (раз в 10 мин) или ручной `accounts cleanup`, `.runtime/candidates/run.log` хранит один `.previous`.

---

## 3. Ошибки и контракты

### 3.1 Что есть сейчас

| Точка | Форма ошибки | Что видит внешний скрипт |
|---|---|---|
| `lib/Connect.js` | `ConnectError{code:'validation'|'timeout'|'network'|'http'|'json', status, data}` (40–47, 138–191) | код и HTTP-статус — единственный структурированный контур |
| `Client.wait` timeout | `Error` с текстом «Нет подтверждения сервера за N секунд…» (359–364) | только текст |
| `Client._packet`, ветка `errors` | `Error('Сервер отклонил действие: пакет …')`, для `24129` — подпись из `data/team-errors.json` (331–342) | только текст, иногда с кодом команды |
| `Client._packet`, decrypt/decode | `Debugger.error` + `emit('warning')`; пакет пропускается (Messaging.js:81–86) | ничего: вызывающий получит timeout |
| `Messaging.send`, encrypt | лог и `return` без ошибки (493–502) | ничего: `request` ждёт полный timeout |
| `Protocol.encode` | `Error` без `code`; неизвестный id → version `0` молча (281) | текст |
| `Fleet` результат | `{ok:false,error:string}` либо `{ok:true,result:[{index,error:string}]}` (381–385, 400–408) | строку |
| `CLI --json` | `{ok:false,error:{message,code?}}`, код возврата `1` или `2` (71–78, 360–370) | `code` только для `unconfirmed` |

Следствие видно в коде: `CandidateRunner` вынужден распознавать ошибки регулярками по русскому тексту — `/команда 10:/` (88) и `/proxy|SOCKS5|Нет ответа сервера|timed out/i` (149). Это самый надёжный индикатор, что контракта не хватает.

Отдельно: `Client.request` не передаёт `options.errors` по умолчанию (370–377) — набор «ошибочных» пакетов задаёт каждый вызов; забытый `errors` превращает отказ сервера в 20-секундный timeout.

### 3.2 Предлагаемый контракт (минимальный, аддитивный)

```js
// lib/Errors.js (новый файл)
class NullsError extends Error {
  constructor(code, kind, message, { retryable = false, details = null, cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'NullsError';
    this.code = code;      // стабильный машинный идентификатор
    this.kind = kind;      // группа для политики
    this.retryable = retryable;
    this.details = details; // packet id, team code, expected types, status, account…
  }
}
// kind: validation | auth | server | protocol | network | proxy | timeout | state | config | internal
```

Маппинг точек (вводить постепенно, не переписывая):

| Источник | `code` | `kind` | `retryable` |
|---|---|---|---|
| `Client.wait` timeout | `confirm_timeout` | `timeout` | да |
| пакет из `options.errors`, включая `24129` | `server_rejected` | `server` | нет (кроме явных кодов перегрузки — проверить) |
| `loginFailed` / `permanentError` | `auth_rejected` | `auth` | нет |
| `socket close/error`, `ECONNRESET` | `network_closed` | `network` | да |
| ошибка `ProxyConnect`/`loadPool` | `proxy_error` | `proxy` | да |
| decrypt/decode пакета | `protocol_decode` | `protocol` | нет (пакет потерян) |
| encrypt в `Messaging.send` | `protocol_encode` | `protocol` | нет |
| `client.state !== 'online'` | `not_online` | `state` | да (после reconnect) |
| `Protocol`/`Actions` валидация | `validation` | `validation` | нет |
| `confirmed:false` | `unconfirmed` | `server` | нет |

Точки внедрения, по одной:

1. `lib/Client.js#wait` / `#request` — обернуть timeout, `errors`, `state` в `NullsError`; старый `message` сохранить.
2. `lib/Client.js#_packet` — в ветке `errors` парсить `24129` в `details.teamCode` + `details.packet`; пробрасывать код команды.
3. `lib/Client.js#_startOpen` (сокет, прокси) и `utils/ProxyConnect.js` — `network_closed`/`proxy_error` с `details.host/port/proxyHost`.
4. `Messaging/Messaging.js#send` — возвращать `false`/бросать `protocol_encode` вместо молчаливого `return`; `Client.request` сразу реджектит, не ждёт timeout.
5. `Messaging/Messaging.js#update` — при ошибке decrypt/decode инкрементировать счётчик (`this.stats.decryptErrors++`) и отдавать в `Client._packet`/событие, чтобы флот видел деградацию.
6. `lib/Fleet.js#processCommands`/`runOne` — писать `{ok:false, error:{code,kind,retryable,message,details}}` **и** сохранять `error` строкой для совместимости; в `result[]` — `{index, error:{…}, errorMessage}`.
7. `lib/CLI.js#logger.failure` — добавлять `kind/retryable/details`, сохраняя текущие `message`/`code`; зафиксировать коды возврата: `0` ok, `1` internal, `2` unconfirmed (уже есть), `3` validation, `4` timeout/network (новые — только если внешние скрипты не завязаны на «всё кроме 2 = 1»).
8. `tools/connect.js` — оставить `ConnectError`, но переименовать коды в общий набор (`validation|timeout|network|http|json`) и не менять exit-коды без записи в `CHANGELOG`/`docs/SCRIPTS.md`.

Правило совместимости: `docs/SCRIPTS.md` §2 обещает `Actions.execute` и `Store`; поэтому строковые `error` и `result` не удалять, только добавлять поля. Это укладывается в §3 документа («добавление новых полей не ломает чтение»).

---

## 4. Расширяемость

### 4.1 Сколько мест правится

| Сценарий | Обязательные правки | Дополнительно | Итого |
|---|---|---|---|
| Новая команда | `lib/Protocol.js#encodeBody`, `lib/Actions.js#commands`, ветка/`expected`+`check` в `execute` | `TUI.js#commands`+`#groups`, `docs/features.json`, `docs/COMMANDS.md`, локали `lib/locales/*.json` (2 ключа × 4 языка), `lib/CLI.js` dry-run-список (304–325), тест | **7–10** |
| Новый пакет | `Messaging/LogicLaserMessageFactory.js`, ветка `Client._packet` или класс в `Messaging/Messages/Server/`, `config.packetIds`, `lib/Decode.js` | фикстура `tests/fixtures`, `docs/REQUESTS.md`/`PROTOCOL-MAP.md` | **4–6** |
| Новый язык | `lib/i18n.js` (`SUPPORTED`, `NAMES`), `lib/locales/<lang>.json` | `tools/i18n-check` (сам берёт `SUPPORTED`), тесты `i18n.test.js`, `docs/I18N.md` | **3–5** |
| Новая платформа | `utils/Platform.js` (предикаты, `pythonCommand`, `wakeLock`, `supportsApkUpdate`) | `utils/AutoUpdate.js` (`/system/bin/pm`, python), `tools/fleet.js` (wake-lock), `.github/workflows/ci.yml`, `docs/PLATFORMS.md` | **4–6** |
| Новый фоновый инструмент | свой `pid`-файл, `owned()`, `status.json`, лог, `atomic()` | ротация лога, очистка, `docs/*` | **5+ копий** |

Дублирование уже измеримо: 65 команд в `Actions.commands`, 63 в `TUI.commands` (без `login`/`create-account` — осознанно), 65 в `docs/features.json`, 65 `case` в `Protocol`, 18 имён в dry-run-списке `CLI`. Статус команды тоже размазан: `team-brawler` есть в `Actions.commands`, `Protocol.encodeBody` для него **всегда** бросает (84–85), в `docs/features.json` он `unavailable`, в `TUI` заблокирован через `features`, а в CLI `--dry-run` всё равно вызовет `Protocol.encode` и упадёт. Единого «источника правды» нет.

### 4.2 Что сократить без большого взрыва

1. **Дескриптор команды** (`lib/Commands.js`) — один объект на команду:
   ```js
   'club-answer': {
     encode: (s, a) => { /* … */ },
     expect: { types: [24312, 24399], errors: [24332] },
     check: (client, packet, a) => Boolean(client.clubStream),
     meta: { experimental: false, status: 'live-verified', tui: { fields: [...] } },
   }
   ```
   `Protocol.encode` читает `encode`, `Actions.execute` — `expect/check`, `TUI` — `meta.tui`, `CLI` — `meta.status`. Это L-работа, но её можно делать по группам (club/team/friends), а не все 65 сразу.
2. **Валидатор каталога** (S): тест, который сверяет `Actions.commands` ↔ `Protocol` ↔ `features.json` ↔ `TUI.commands` ↔ dry-run-список и падает на расхождении. Сначала ловит `team-brawler`, потом делает рефакторинг безопасным.
3. **`lib/Status.js`** — один читатель `fleet-status.json`/`fleet.pid`/`results` для `watch`, `tools/fleet.js status` и внешних скриптов; `watch` перестаёт угадывать формат.
4. **`lib/Daemon.js`** — `owned()`, `atomic()`, `writePid/readPid`, `status`, `rotateLog`. Сейчас копии: `tools/fleet.js:128–144`, `tools/candidates.js:10–19`, `tools/proxy-watch.js:18–33`, `tools/test-session.js:11–20`.
5. **`lib/Paths.js`** — все пути состояния в одном месте (сейчас `Fleet` собирает `.runtime/commands`, `Connect` — `.runtime/connect.json`, `Client` — `.runtime/udp-proxies.json`, `CandidateRunner` — `.runtime/candidates/accounts`, `tools/test-session` — `.runtime/test-session`).
6. **`lib/Config.js`** — `read()`, `patch(patch, {revision})`, один writer; убирает четыре независимых `Store.write(config.json)`.

---

## 5. Производительность и ресурсы

### 5.1 Горячие пути

| Путь | Что происходит | Стоимость | Где |
|---|---|---|---|
| Сокет-обработчик | `while (pendingJob()) update()` без лимита кадров на тик | один `data`-event может обработать весь буфер и заблокировать event loop; при 100 ботах — очередью | `Client.js:144–154` |
| `Queue` | `Buffer.concat` на каждый `add`, `slice` на каждый `release` | O(n) копирование на кадр; при всплеске — O(n²); 16 МБ cap **на клиента** | `Queue.js:5–16`, `Client.js:148` |
| `Client.save()` | синхронная запись + `rename` на каждый `24124/24125/24399/…` | десятки fsync/с на flash при активном лобби | `Client.js:38–41, 263–271` |
| Лог на каждый кадр | `Debugger.info('recv type=…')` для всех, кроме `20108/49001` | в `fleet run` `Debugger` = `console.log` (`tools/fleet.js:222–227`), а `installTee` пишет в файл **синхронно** (`fs.writeSync`, 73–77) → синхронная запись на каждый принятый кадр | `Messaging.js:89`, `tools/fleet.js:103–111` |
| `Fleet.flushStatus` | JSON всего статуса + `readdirSync(.runtime/commands)` + сравнение строк | до 2 раз/с + heartbeat; `pendingCommands` — sync I/O в hot path статуса | `Fleet.js:137–143, 182–199` |
| `watch` тик | чтение `fleet-status.json`, `accounts/index.json`, tail 256 КБ `fleet.log`, до 50 `results/*.json` | раз в секунду: ~300 КБ + 50 `stat`/чтений; на Android заметно | `watch.js:70–88, 111–143, 193–248, 513` |
| `CandidateLoop.currentEvent` | скан **каждого смещения** Home (до 1 МБ), VInt-чтения | O(len) на каждый цикл каждого бота; Home не кэшируется | `CandidateLoop.js:11–40` |
| `Accounts.read` | при устаревании — полный скан всех файлов + запись индекса | O(N) синхронно в вызывающем потоке | `Accounts.js:97–165` |
| `Actions` polling | `club-settings`: до 10 × 200 мс + `club-info` | до ~2 с удержания действия; сериализует команды бота | `Actions.js:438–442` |
| `BattleSession` | `setInterval(send, 50)` на активный бой | 20 пакетов/с на бота; таймер не `unref`, снимается в `close()` | `BattleSession.js:48–51, 109–120` |

### 5.2 Таймеры и завершение процесса

| Таймер | `unref` | Комментарий |
|---|---|---|
| `Client.deadline` (60 с) | нет | снимается на Home/close, но при «зависшем» сокете держит процесс |
| `Client.reconnectTimer` | нет | снимается в `close`; при `options.reconnect` цикл может длиться бесконечно на **конфигурационной** ошибке (битый `proxy.json`, пустой пул) |
| `Client.wait` item.timer | нет | снимается при resolve/reject; забытый `cancel` держит до timeout |
| `Client.battleRetryTimer` | нет | снимается в `close`; цикл повторяется каждые 1–15 с при недоступном UDP |
| `Fleet.flushTimer` | да (180) | корректно |
| `Fleet.start` interval | нет | это демон, ожидаемо; но `new Fleet(...).start()` в библиотеке/тесте без `stop()` держит процесс |
| `Accounts.upsert` timer | да (240) | корректно |
| `CandidateRunner.timer` | нет | демон; останавливается `stop()` |
| `watch` interval | нет | интерактивный дашборд, ожидаемо |
| `Messaging.keepAlive` | да (302) | корректно |
| `Messaging.actionTimeout` | да (322) | корректно |

Отдельно: таймаут `Client.wait` не имеет общего бюджета с `socket.setTimeout(30s)` и `connectTimeout(60s)`. При деградации сети три независимых таймера дают разный текст ошибки на один и тот же сбой.

### 5.3 Память и рост

- Лимит входящей очереди 16 МБ задан **на клиента** (`Client.js:148`). Для 100 ботов теоретический потолок — 1.6 ГБ; бюджет `tools/test-session.js` — 160–512 МБ (`rssMb`). Нужен общий бюджет пула и меньший per-client cap с backpressure.
- `Queue` хранит `Buffer` и после `slice` может удерживать большой underlying buffer до следующего `add`.
- `PacketsDumps/` растёт без ограничений; `proxy-watch.log` — без ротации; `.updates/backups` — без очистки; `.runtime/results` — только при живом `fleet run`.
- `Fleet.metrics.loginTimes` ограничен 200 (`LOGIN_SAMPLES`), `Client.invitations` — 50 (308), `clubStream` — не ограничен (проверить: поток клуба может расти при долгой сессии), `Client.pending` — по числу одновременных ожиданий.

---

## 6. Тестируемость

### 6.1 Что уже хорошо

- `Fleet` принимает `ClientType` (32) — тесты подставляют `FakeClient` (`tests/fleet.test.js:23`).
- `TUI.App` принимает `{Client, execute}` (329–332).
- `watch.collectFrame({root, options, now, width})` — чистый сборщик кадра (193), тесты вызывают его с временным root.
- `Accounts.*(root, …)` — функции принимают корень, не читают глобальный.
- `i18n.detectInfo({env, systemLocale})` — тестовый хук (165–181).
- `Connect` использует `global.fetch` — тесты подменяют его (`tests/connect.test.js:10–30`).
- `tools/package_release.py --check` даёт детерминированную проверку бандла.

### 6.2 Что мешает

| Препятствие | Проявление | Файлы |
|---|---|---|
| Глобальный `Debugger` | `Client` ставит, `CLI`/`Fleet`/`TUI` перезаписывают, тесты сохраняют/восстанавливают вручную | `Client.js:34`, `CLI.js:36–53`, `TUI.js:864–866`, `tests/fleet.test.js:310–316` |
| Глобальное состояние `i18n` | `current` и `cache` — модульные; `setLanguage` влияет на весь процесс | `i18n.js:14–15` |
| Глобальное состояние `Accounts` | `pendingWrites`, `warned` — модульные, ключ — `root`; таймер живёт между тестами | `Accounts.js:15–16, 219–243` |
| `Store` без инъекции | тесты вынуждены подменять `Store.write` (monkeypatch экспорта) | `tests/fleet.test.js:44–52` |
| `Client` жёстко требует модули | `AccountLock`, `BrawlTV`, `BattleProtocol`, `BattleSession` грузятся изнутри | `Client.js:51, 229–243, 413` |
| `CLI.run` не экспортирован | тестируется через `main` с подменой `process.stdout.write` и `process.exitCode`; `run` недоступен | `CLI.js:184–396`, `tests/cli-options.test.js:5–30` |
| `Connect` фиксирует базы при загрузке | `BASE`/`PROFILES_BASE` из env читаются один раз (37–38) | `Connect.js` |
| Реальные таймеры | Fleet-тесты спят по 2 с, `CandidateRunner` — 1 с; нет fake timers | `tests/fleet.test.js:59, 106–126` |
| `/proc`, `process.memoryUsage`, spawn | демоны и RSS-бюджет не тестируются без Linux | `CandidateRunner.js:176–231`, `tools/test-session.js:78–98` |
| `NullsLicense` читает файл и мутирует config | тест должен подготовить `client-license.bin` и `apkSize` | `utils/NullsLicense.js`, все интеграционные тесты |

### 6.3 Швы, которые дают максимум за минимум

1. `lib/Logger.js` с `createLogger({level, sink})` и no-op по умолчанию; `global.Debugger` оставить как shim на время миграции.
2. Инъекция `{store, logger, clock}` в `Client` и `Fleet`; `Store` оставить функциональным модулем, но вызывать через `this.store`.
3. Экспорт `CLI.run(argv, {io, store, i18n})` рядом с `main`; `main` только собирает реальные зависимости.
4. `Accounts` — фабрика/инстанс с `root` или явный `resetForTests()`; убрать `warned` в пользу логгера.
5. `lib/Paths.js` — тесты перестают зависеть от `<repo>/.runtime`.
6. `lib/Clock.js` (`now`, `setTimeout`) для `Fleet`/`Accounts`/`watch`; тесты без `sleep`.
7. Валидатор каталога команд (см. §4) — table-driven тест вместо перечисления в трёх местах.

---

## 7. Приоритетный план

| # | Что сделать | Зачем | Риск | S/M/L | Файлы |
|---|---|---|---|---|---|
| 1 | Исправить `Fleet.js:304`: `Actions.same(client.club, target(this.options.clubTag))`; добавить тест на `slot.joined === true` | статус врёт о членстве в клубе; внешние скрипты принимают решения по `joined` | низкий | S | `lib/Fleet.js`, `tests/fleet.test.js` |
| 2 | Ввести `lib/Errors.js` и классификацию в `Client.wait/request/_packet`, `Messaging.send/update`; строковый `message` не менять | убрать regex-парсинг ошибок, дать `retryable` флоту и скриптам | средний: меняются тексты/поля в тестах | M | `lib/Client.js`, `Messaging/Messaging.js`, новый `lib/Errors.js` |
| 3 | `Messaging.send` при ошибке encrypt — вернуть ошибку/`false`, `Client.request` реджектить сразу | сейчас отказ шифрования выглядит как 20-секундный timeout | низкий | S | `Messaging/Messaging.js`, `lib/Client.js` |
| 4 | `Fleet` результаты: добавить `error:{code,kind,retryable,details}`, сохранив `error` строкой; `CLI --json` — те же поля | внешний скрипт различает «сервер отказал», «сеть», «timeout» | средний (контракт `.runtime/results`, но аддитивно) | M | `lib/Fleet.js`, `lib/CLI.js`, `docs/FLEET.md`, `docs/SCRIPTS.md` |
| 5 | Убрать/перевести на `Store` `Messaging.saveAccount/saveConfig`; удалить мёртвый `runAction` после подтверждения, что он не нужен внешним скриптам | два способа записи учётных данных, один неатомарный; мёртвый дубль команд | средний: тесты `profile-social` используют `runAction` | M | `Messaging/Messaging.js`, `tests/profile-social.test.js` |
| 6 | Ограничить обработку кадров на тик (`MAX_FRAMES`/`setImmediate`) и переписать `Queue` на rolling buffer без `concat` на каждый `add` | event-loop starvation и O(n²) на всплесках | средний: трогает приём пакетов | M | `lib/Client.js`, `DataStream/Queue.js`, тесты `hello-wire`/`session-fleet` |
| 7 | Снизить per-client cap очереди (например, 2 МБ) + общий бюджет пула/флота; при переполнении — `network_closed` с `retryable` | 16 МБ × 100 клиентов несовместимы с бюджетом Termux | средний: возможны ложные disconnect на медленной сети | M | `lib/Client.js`, `lib/Fleet.js`, `lib/CandidateRunner.js` |
| 8 | Ввести уровни логгера; в `fleet run` писать `info` только при `--verbose`/семплинге, оставить `warn/error`; не делать sync `fs.writeSync` на каждый кадр | сейчас каждый кадр — синхронная запись в `fleet.log` | низкий | S | `tools/fleet.js`, `Messaging/Messaging.js`, `lib/Client.js` |
| 9 | Дебаунс `Client.save()`: писать аккаунт не чаще 1 раза/с и только при изменении полей (`team/club/name/token`) | `24124` в активном лобби даёт запись на каждый пакет | средний: можно потерять последнее состояние при kill -9 | M | `lib/Client.js` |
| 10 | `lib/Status.js` + перевод `watch` на него; кэш `results` по `mtime`, инкрементальный tail `fleet.log` | один контракт статуса, меньше I/O на тик | низкий/средний | M | `tools/watch.js`, новый `lib/Status.js`, `tests/watch.test.js` |
| 11 | `lib/Daemon.js`: общий `owned()`, `readPid/writePid`, `atomic`, `rotateLog`; подключить `proxy-watch` (ротация лога), `candidates`, `test-session` | 4 копии логики и разные форматы статусов | низкий | M | `tools/fleet.js`, `tools/candidates.js`, `tools/proxy-watch.js`, `tools/test-session.js`, новый `lib/Daemon.js` |
| 12 | Валидатор каталога команд (тест): `Actions.commands` ↔ `Protocol` ↔ `features.json` ↔ `TUI.commands` ↔ dry-run-список; пометить `team-brawler` согласованно | ловит дрейф до рефакторинга; сейчас `team-brawler` обещан, но всегда бросает | низкий | S | `tests/compat-scripts.test.js` или новый `tests/catalog.test.js`, `lib/CLI.js`, `docs/features.json` |
| 13 | `lib/Config.js` с `patch()` и проверкой ревизии для `config.json`; перевести `CLI`, `TUI`, `Client`, `AutoUpdate` | четыре писателя затирают друг друга | средний: `AutoUpdate` уже имеет свою защиту | M | новый `lib/Config.js`, `lib/CLI.js`, `lib/Client.js`, `TUI.js`, `utils/AutoUpdate.js` |
| 14 | Защитить `udp-proxies.json`: merge под файловым lock или писать только дельту с повтором | потеря обновлений при одновременном подтверждении прокси | низкий | S | `lib/Client.js` |
| 15 | Добавить очистку `PacketsDumps/`, `.updates/backups`, `working-proxies.txt` в `Accounts.cleanup`/`tools/fleet.js` | неограниченный рост на телефоне | низкий | S | `lib/Accounts.js`, `tools/fleet.js`, `tools/proxy-watch.js` |

Порядок исполнения: 1 → 3 → 2 → 4 → 12 → 8 → 6/7 → 9 → 10 → 11 → 13 → 14 → 15 → 5 (удаление legacy — последним, после проверки внешних скриптов).

### 7.1 Что НЕ стоит делать

- **Полный DI-фреймворк / перевод на TypeScript.** 95 файлов и 168 тестов не окупят переписывание; достаточно точечных инъекций (§6.3).
- **Асинхронный `Store`.** Атомарность и синхронность здесь — преимущество для CLI; делать `async` ради «правильности» значит переписать всех вызывающих.
- **Замена файловой очереди команд на HTTP/сокет.** Это ломает `docs/SCRIPTS.md` и внешние скрипты; файловая очередь работает и переживает рестарт CLI.
- **Единая декларативная схема всех 65 команд сразу.** Сначала валидатор (п.12), затем миграция группами; big-bang даст регресс в протоколе.
- **Общий event bus / глобальная шина.** Уже есть события `Client`; шина добавит неявные связи вместо явных вызовов.
- **Блокировки на уровне БД/реестра.** Файловый lock + версия в `config.json` достаточны для 1–2 процессов.
- **Оптимизация отрисовки TUI.** Полный redraw на keypress при 3 строках лога — не bottleneck; трогать не нужно.
- **Автоматическая миграция `accounts/index.json`.** Это производный кэш; лучше пересборка и валидатор, чем миграции.
- **Переписывание `Actions` в «чистые» сценарии до появления `lib/Commands.js`.** Сначала дескриптор и тесты, потом разрезание.

---

## Приложение. Что требует живой проверки

1. `slot.joined` после реального `join-club` — подтвердить, что дефект `Fleet.js:304` виден в `fleet-status.json` (ожидается `false` при успешном входе в клуб).
2. Реакция флота на битый `proxy.json`/пустой пул: проверить, что цикл `_schedule` не крутится бесконечно и не маскирует конфигурационную ошибку под сетевую.
3. Частота пакетов `24124` в реальном лобби на 5–10 ботах — от неё зависит выигрыш от дебаунса `Client.save()`.
4. Доля ошибок decrypt/decode в длинной сессии (`Messaging.update`, 81–86) — сейчас не измеряется; нужна метрика перед изменением контракта.
5. Поведение `Accounts.isStale` при замене файла с тем же количеством (переименование `bot-1.json` ↔ `bot-2.json`) — воспроизвести и решить, нужен ли хэш/mtime-набор.
6. Стоимость тика `watch` на Termux при 50+ ботов и 50 файлах результатов — замерить RSS/CPU до переписывания на `lib/Status.js`.
7. Нужен ли внешним скриптам `Messaging.runAction` — перед удалением legacy-пути проверить `docs/SCRIPTS.md` и реальные скрипты в `/sdcard/nulls-tools` (в репозитории их нет).