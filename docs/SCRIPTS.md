# Контракт для внешних скриптов

Документ фиксирует, на что может опираться скрипт, лежащий **вне репозитория** и скопированный в `<repo>/tools/`. Всё, что здесь перечислено, считается стабильным API. Всё, что не перечислено, — внутренняя реализация и может измениться в любой момент.

## 1. Как устроен внешний скрипт

Пользовательские скрипты (`club-rush.js`, `team-spam.js`, `club-check.js`, `patch-license.js`) живут в `/sdcard/nulls-tools` и копируются в `<repo>/tools/`. Скрипт:

- лежит в `<repo>/tools/`, поэтому `require('../lib/...')` ведёт в корень клиента;
- сам вычисляет корень: `const ROOT = path.resolve(__dirname, '..')`;
- читает `<ROOT>/config.json` и передаёт его в клиентские модули;
- не правит файлы репозитория, только использует их.

Минимальный каркас:

```js
#!/usr/bin/env node
const path = require('node:path');
const {parse} = require('../lib/Args');
const Client = require('../lib/Client');
const Actions = require('../lib/Actions');
const Store = require('../lib/Store');

const ROOT = path.resolve(__dirname, '..');

async function main() {
  const {options, positional} = parse(process.argv.slice(2));
  const client = new Client({root: ROOT, account: options.account || 'accounts/bot-1.json', reconnect: false});
  client.on('warning', error => console.warn(error.message));
  try {
    await client.connect();
    const result = await Actions.execute(client, positional[0], options);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    client.close();
  }
}
main().catch(error => {console.error(error.message); process.exitCode = 1;});
```

Обязательный `Debugger` ставить не нужно: `lib/Client.js` подставляет глобал, если его нет.

## 2. Стабильный API

| Модуль | Что импортируется | Гарантия |
|---|---|---|
| `../lib/Args` | `parse(argv)` → `{options, positional}` | имена флагов через `--kebab-case` → `options.camelCase`; `--flag` без значения → `true`; ошибка на `--key` без значения |
| `../lib/Client` | `new Client(options)`, `connect()`, `close()`, `reconnect()`, `request()`, `wait()`, `save()`, `on(...)` | набор опций и событий из раздела 4; `state` принимает только документированные значения |
| `../lib/Actions` | `execute(client, command, args)`, `commands`, `experimental`, `publicAccount`, `same` | `execute` возвращает объект с `confirmed`; отвергает неизвестную команду исключением |
| `../lib/Protocol` | `encode(command, args)` → `{id, payload, version}`, `target(tag)`, `readReference`, `reference`, `integer`, `text`, `roles` | формат `{id, payload, version}`; исключение на невалидных аргументах |
| `../lib/Store` | `read(file, fallback)`, `write(file, value)` | атомарная запись через временный файл + `rename`, режим `0600` |
| `../lib/ProxySources` | `sources`, `normalize(value, protocol)`, `download(source, signal, maxBytes)`, `select(groups, used, count, offset)` | `normalize` возвращает `null` для приватных сетей и прокси с учётными данными |
| `../utils/ProxyConnect` | `parseProxy(value)`, `connectSocket(socket, {host, port, proxy}, ready)`, `loadProxy`, `loadPool`, `associateUdp` | `parseProxy` → `{type, host, port, username, password}`; `connectSocket` вызывает `ready` только после установки туннеля |
| `../utils/TagCodec` | `logicLongToTag(hi, lo)`, `tagToLogicLong(tag)`, `describeTag(tag)`, `normalizeTag`, `encodedIdToTag`, `tagToEncodedId` | `logicLongToTag`/`tagToLogicLong` — взаимно обратны; исключение на мусоре |
| `../utils/NullsLicense` | `apply(config, root)` → `config` | дописывает `loginClientSeed` и `createHelloExtra`; остальные поля не трогает |
| `../Messaging/Messages/Client/ModernClientHelloMessage` | `new Hello(config)` → `encode()` → `ByteStream.getBytes()` | состав hello-пакета для `cryptoMode: 'nulls-native19'` |
| `<ROOT>/config.json` | ключи `host`, `port`, `packetIds.*`, `cryptoMode`, `clientLicensePath`, `apkSize` | имена ключей; значения — по мере обновления клиента |

Проверка handshake без сессии (как в `tools/proxy-watch.js`):

```js
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json')));
require('../utils/NullsLicense').apply(config, ROOT);
const Hello = require('../Messaging/Messages/Client/ModernClientHelloMessage');
const message = new Hello(config); message.encode();
const body = message.ByteStream.getBytes();
const header = Buffer.alloc(7);
header.writeUInt16BE(config.packetIds.clientHello, 0);
header.writeUIntBE(body.length, 2, 3);
socket.write(Buffer.concat([header, body]));
```

## 3. Что можно менять только мажорной версией

Перечисленное ниже ломает внешние скрипты. Менять — только с повышением мажорной версии и записью в `CHANGELOG.md`:

- имена и сигнатуры функций из таблицы раздела 2;
- имена опций конструктора `Client` и значения `client.state`;
- имена событий `Client` и их аргументы;
- структуру возврата `Actions.execute` (`confirmed`, `command`, `response`, `note`, `stage`);
- имена полей в `config.json`, которые читают скрипты (`packetIds.*`, `cryptoMode`, `clientLicensePath`, `apkSize`, `host`, `port`);
- формат `accounts/*.json` (`hi`, `lo`, `passToken`, `name`, `club`, `team`);
- расположение `lib/`, `utils/`, `Messaging/` относительно `tools/`.

Безопасно менять в минорной версии: внутренности `Decode`, `Messaging.update`, приватные поля клиента (с префиксом `_`), структуру `.runtime/`, набор полей в результатах — **добавление** новых полей не ломает чтение.

## 4. Клиент: опции и события

```js
const client = new Client({
  root: ROOT,                        // корень репозитория
  account: 'accounts/bot-1.json',    // путь относительно root
  name: 'МойБот',                    // ник только при создании аккаунта
  reconnect: true,                   // автоматический перезаход после разрыва
  proxyFile: 'proxy.json',           // один прокси
  proxyPoolFile: 'working-proxies.json', // пул, выбирается по index
  index: 1,                          // сдвиг выбора прокси в пуле
  dump: false,                       // писать кадры в PacketsDumps/
  battleTransport: 'none',           // 'udp' — поднять боевой UDP-канал
  idleTimeout: 30000,                // таймаут молчания сокета
  connectTimeout: 60000,             // предел на весь вход
  onProxyPoolEmpty: () => {},        // пул пуст
});
```

События и их аргументы:

| Событие | Аргумент | Когда |
|---|---|---|
| `state` | `{state, error}` | каждая смена состояния |
| `packet` | `{type, payload, at}` | каждый успешно расшифрованный кадр |
| `online` | — | вход подтверждён, Home получен |
| `disconnected` | — | сокет закрыт |
| `warning` | `Error` | ошибка разбора, прокси, боевого канала |
| `account` | `account` | аккаунт сохранён |
| `battle-packet` | пакет боя | при `battleTransport: 'udp'` |
| `battle-vision` | обновление видимости | при `battleTransport: 'udp'` |

Состояния: `stopped`, `connecting`, `authenticating`, `setting-profile`, `reconnecting`, `online`, `failed`, `blocked`. Проверять готовность — только по `client.state === 'online'`, не по наличию сокета.

Ожидание конкретного пакета:

```js
const waiter = client.wait([24124], packet => Boolean(client.team), [], 10000);
// ... отправка ...
await waiter.promise;      // либо waiter.cancel(new Error('...'))
```

`wait` бросает исключение по таймауту; отменяйте его в `catch`, иначе ожидание останется висеть до срока.

## 5. Состояние: чтение и запись

Только через `Store`:

```js
const Store = require('../lib/Store');
const state = Store.read(path.join(ROOT, '.runtime/my-state.json'), {});
Store.write(path.join(ROOT, '.runtime/my-state.json'), {...state, lastRun: new Date().toISOString()});
```

Правила:

- не пишите в `accounts/*.json` напрямую — это делает `Client.save()`; ручная запись может перетереть `passToken`;
- свой прогресс храните в `.runtime/` (эта папка в `.gitignore`), а не в корне;
- `config.json` меняйте только через `Store.write` и только если это предусмотрено скриптом (например, обновление версии);
- файлы с `0600` создаёт `Store.write`; не перезаписывайте их через `fs.writeFileSync` без режима.

## 6. Чего делать нельзя

- **Патчить репозиторий из скрипта.** Никаких правок `lib/*`, `utils/*`, `Messaging/*`, `config.json` «на лету» через `fs.writeFileSync` — при обновлении клиента такие патчи молча перестанут применяться или испортят файл. Если чего-то не хватает, используйте публичные функции или заведите issue.
- **Копировать внутренние модули к себе и импортировать их минуя `tools/`.** `require('../lib/...')` работает только пока скрипт лежит в `tools/`.
- **Держать один аккаунт в двух процессах.** `AccountLock` не даст, но и обходить его (`fs.unlinkSync(lock)`) нельзя — получите два сокета с одним токеном и разлогин.
- **Логировать `passToken`, содержимое `accounts/*.json`, `.runtime/connect.json`.**
- **Считать отправку подтверждением.** `confirmed: false` в результате означает «сервер не подтвердил»; не переписывайте это на `true`.

## 7. Проверка после обновления клиента

1. `node tools/<script>.js help` (или тот флаг, который поддерживает сам скрипт) — скрипт загрузился, зависимости на месте.
2. Сухой прогон, если он есть: `--dry-run` показывает сформированный пакет без сети (в `lib/CLI.js` для ряда команд, `Protocol.encode` для остальных).
3. `node --check tools/<script>.js` — синтаксис.
4. `npm test` в корне — 82 теста, включая контракты протокола и прокси.
5. Один живой прогон на тестовом аккаунте: `node tools/<script>.js ... --once`.
6. Сверка сигнатур: если упало на `TypeError: X is not a function` — смотрите таблицу раздела 2 и `CHANGELOG.md`.

При поломке порядок такой: проверить сигнатуру в текущем файле (`grep -n "module.exports" lib/...`), сверить с таблицей, затем `node --check`, затем тесты. Если изменился `config.json` (новая версия клиента), обновите `packetIds`/`apkSize` через `npm run update` — не правьте руками то, что приходит из APK.

## 8. Где смотреть статусы

| Файл | Что показывает |
|---|---|
| `.runtime/candidates/status.json` | состояние раннера кандидатов |
| `.runtime/results/*.json` | результат конкретной команды `fleet command` (`ok`, `result`, `error`) |
| `fleet-status.json` | снимок флота: `states`, `bots[]`, `updatedAt`, `pid` |
| `working-proxies.json` | проверенный пул прокси (от `tools/proxy-watch.js`) |
| `proxy-watch-status.json` | статус проверяльщика прокси |
| `.runtime/udp-proxies.json` | прокси, подтверждённые для UDP-канала боя |
| `fleet.log`, `proxy-watch.log` | логи фоновых процессов |

## 9. Таблица совместимости

| Модуль | Что гарантируем | Что может измениться |
|---|---|---|
| `lib/Args` | `parse(argv)` и имена флагов | набор флагов в `booleans` |
| `lib/Client` | опции, события, состояния, `connect/close/reconnect/request/wait` | внутренние поля, алгоритм выбора прокси |
| `lib/Actions` | `execute`, `commands`, `experimental`, формат `confirmed` | состав веток, набор команд, детали `note` |
| `lib/Protocol` | `encode` → `{id, payload, version}`, хелперы валидации | таблица id — вместе с `config.json` |
| `lib/Store` | `read`/`write`, атомарность, `0600` | ничего в сигнатуре |
| `lib/ProxySources` | `sources`, `normalize`, `download`, `select` | список источников, лимиты загрузки |
| `utils/ProxyConnect` | `parseProxy`, `connectSocket` | внутренний протокол туннеля |
| `utils/TagCodec` | преобразования тег ↔ LogicLong | дополнительные хелперы |
| `utils/NullsLicense` | `apply(config, root)` | внутренний формат лицензии — только с новой версией APK |
| `ModernClientHelloMessage` | `new Hello(config)` → `encode()` → `getBytes()` | состав полей — вместе с протоколом |
| `config.json` | ключи из раздела 2 | значения при обновлении клиента |