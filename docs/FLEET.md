# Флот ботов (Fleet)

`lib/Fleet.js` поднимает несколько сессий `lib/Client.js` в одном процессе, ведёт их состояния и
принимает команды через файловую очередь. CLI — `tools/fleet.js`.

## Файлы

| Путь | Кто пишет | Назначение |
| --- | --- | --- |
| `accounts/bot-N.json` | пользователь / `create-account` | аккаунт бота с индексом `N`; только читается |
| `.runtime/commands/<uuid>.json` | CLI | входящая команда для работающего флота |
| `.runtime/results/<uuid>.json` | флот | результат команды |
| `fleet-status.json` | флот | публичный снимок состояния, контракт ниже |
| `fleet.pid` | `fleet run` | PID процесса, файл удаляется при SIGINT/SIGTERM |
| `fleet.log` | `fleet start` | stdout/stderr фонового процесса, режим `0600` |

Каталоги `.runtime/commands` и `.runtime/results` создаются в конструкторе. Все пути собираются
через `path.join`, поэтому одинаково работают на Windows и POSIX.

## Запуск

```sh
node tools/fleet.js start --count 3 --first 1 --concurrency 3 --club-tag '#TAG'
node tools/fleet.js status
node tools/fleet.js stop
node tools/fleet.js run --count 3          # на переднем плане
```

`--count` — 1…100, `--concurrency` — одновременных подключений, 1…20 (по умолчанию 3).
`--first` — первый индекс слота. Для каждого слота читается `accounts/bot-N.json`; битый файл
переводит слот в `failed` и не мешает остальным.

## Очередь запуска

`pump()` поддерживает два курсора (`readyCursor` и `anyCursor`) и не сканирует все слоты на каждый
запуск:

1. сначала выбирается `queued`-бот с `registered: true`;
2. если таких нет — любой `queued`;
3. пустая очередь — выход.

Курсор идёт по кругу, поэтому ни один слот не теряется; после `launch()` статус сразу меняется на
`connecting`, и повторно тот же бот не выбирается. `inflight` ограничен `concurrency`.

## Статус `fleet-status.json`

Публичный API `new Fleet(...)`, `start()`, `stop()`, `snapshot()` сохранён. `snapshot()` больше не
пишет файл синхронно: он только помечает состояние изменённым и планирует запись.

- запись выполняется не чаще одного раза в 500 мс (2 записи в секунду) — `--status-interval`;
- если содержимое (всё, кроме `updatedAt`) не изменилось, запись пропускается;
- раз в 30 секунд пишется heartbeat, чтобы `updatedAt` оставался свежим — `--status-heartbeat`;
- `start()` пишет первый снимок сразу, `stop()` делает финальный синхронный flush со статусами
  `stopped`;
- таймеры flush-а имеют `unref()`, поэтому процесс завершается по SIGTERM.

Поля и их порядок стабильны:

```json
{
  "pid": 12345,
  "updatedAt": "2026-11-21T12:00:00.000Z",
  "first": 1,
  "requested": 3,
  "clubTag": "#TAG",
  "states": { "online": 2, "connecting": 1 },
  "creationPaused": null,
  "bots": [
    {
      "index": 1,
      "status": "online",
      "registered": true,
      "joined": true,
      "attempts": 0,
      "error": null,
      "name": "Bot1",
      "tag": "#ABC123",
      "onlineSince": "2026-11-21T11:59:00.000Z",
      "lastServerAt": "2026-11-21T12:00:00.000Z",
      "matchmaking": null
    }
  ]
}
```

`creationPaused` — `null` или строка `Приостановлено командой пользователя`.

### Состояния слота

| Статус | Значение |
| --- | --- |
| `queued` | ждёт запуска |
| `connecting` | идёт подключение/вход, первый вход ограничен 90 с |
| `joining-club` | вход подтверждён, выполняется `join-club` |
| `online` | сессия работает |
| `failed` | подключение или вход не удались |
| `blocked` | сервер отказал постоянно (нужен `retry`) |
| `stopped` | флот остановлен |

### Чтение из своих скриптов

Контракт — поля выше. Не сравнивайте весь файл целиком: `updatedAt` меняется по heartbeat.
Пример на Node.js:

```js
const fs = require('node:fs');
const status = JSON.parse(fs.readFileSync('fleet-status.json', 'utf8'));
const alive = status.pid && status.updatedAt && Date.now() - Date.parse(status.updatedAt) < 90000;
const online = status.bots.filter((bot) => bot.status === 'online').map((bot) => bot.index);
console.log({ alive, online, states: status.states });
```

Проверка «флот жив»: `node tools/fleet.js status` добавляет `running` (PID из `fleet.pid`).
Возраст `updatedAt` больше 90 с при `running: false` означает, что процесс уже не работает.

## Команды

CLI пишет `.runtime/commands/<uuid>.json` и ждёт `.runtime/results/<uuid>.json`:

```sh
node tools/fleet.js command --bot 2 --action friends --timeout 20000
node tools/fleet.js command --all --action chat --text 'привет'
node tools/fleet.js pause
node tools/fleet.js resume
node tools/fleet.js retry
```

- `--bot N` — один бот; `--all` — все слоты.
- `--timeout` (мс, по умолчанию 60000) — ожидание результата; при `--all` умножается на
  `requested` из статуса.
- `pause`/`resume`/`retry` и `retry-registration` — служебные команды без `--action`.

Обработка очереди:

- каталог перечитывается не чаще одного тика; `*.json` захватывается через `fs.rename` в
  `<uuid>.json.processing` до чтения, поэтому два тика или два процесса не возьмут файл дважды;
- «зависшие» `.processing` старше 10 минут удаляются автоматически;
- после обработки файл команды удаляется, результат остаётся в `.runtime/results`;
- при `--all` действия выполняются с ограниченным параллелизмом (`options.commandConcurrency`,
  по умолчанию 8; CLI: `--command-concurrency 8`) и результаты укладываются в массив **в порядке
  возрастания индексов**;
- ошибка одного бота возвращается как `{ index, error }` и не отменяет остальные.

Результат:

```json
{ "ok": true, "result": [{ "index": 1, "confirmed": true }, { "index": 2, "error": "Бот ещё не вошёл" }] }
```

`ok: false` означает ошибку самой команды (неизвестное действие, неверный `--bot`, битый файл).

## Таймауты

| Что | Значение |
| --- | --- |
| первый вход бота | 90 с, затем `failed` |
| ожидание подтверждения команды | `Client.wait`, 20 с по умолчанию |
| действие `Messaging` | 15 с |
| CLI ждёт результат | `--timeout` × `requested` для `--all` |
| `idleTimeout` сокета | 30 с |

## Ограничения Android

- `fleet run` берёт `termux-wake-lock` и отпускает его на SIGINT/SIGTERM; без wake-lock Android
  может усыпить процесс в фоне.
- Проверка «процесс уже запущен» использует `/proc/<pid>/cmdline`, только если `/proc` существует;
  на Windows эта проверка пропускается (см. `docs/PLATFORMS.md`).
- Файлы статуса, PID и логов создаются с режимом `0600`; на Windows режим игнорируется.
- Долгий флот на телефоне ограничен политикой батареи/OEM; надёжнее держать экран включённым или
  запускать на Linux/macOS/Windows.