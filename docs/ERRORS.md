# Ошибки библиотек (ERRORS)

`lib/Errors.js` — единый контракт ошибок для библиотек и внешних скриптов. Вместо разбора русского
текста скрипт смотрит на машинный `err.code`. Текст `err.message` при этом не меняется: поля только
добавляются, поэтому старые скрипты, которые печатают или сравнивают `message`, работают как раньше.

## Поля `AppError`

| Поле | Тип | Назначение |
| --- | --- | --- |
| `code` | `string` | Стабильный машинный код (`UPPER_SNAKE`, у Connect — исторические `timeout`/`network`/`http`/`json`/`validation`). Переименование — только с мажорной версией. |
| `kind` | `string` | Категория: `input`, `config`, `network`, `timeout`, `server`, `state`, `filesystem`, `auth`, `internal`. |
| `retryable` | `boolean` | Есть ли смысл повторять операцию (на уровне пула/планировщика, а не автоматически). |
| `details` | `object` | Машиночитаемый контекст: файл, endpoint, HTTP-статус, таймаут. Секреты сюда не кладут. |
| `cause` | `Error` | Исходная ошибка, если она была. |
| `message` | `string` | Прежний человекочитаемый текст; менять его нельзя. |

```js
const { AppError, codes } = require('./lib/Errors');

throw new AppError(codes.PERMISSION_DENIED, 'EACCES: permission denied, open index.json', {
  details: { file: 'accounts/index.json' },
});

// Обернуть чужую ошибку, сохранив message и cause:
throw AppError.wrap(error, codes.FILESYSTEM_ERROR, { details: { file } });
```

`new AppError(code, message, options)` берёт `kind`/`retryable` из каталога кодов; `options.kind`,
`options.retryable`, `options.details`, `options.cause` переопределяют значения.
`AppError.wrap(error, code, options)` никогда не теряет исходный `message`; для неизвестной ошибки
без явного кода получается `INTERNAL` (`kind: 'internal'`, `retryable: false`).

## Коды

| `code` | `kind` | `retryable` | Когда возникает | Что делать |
| --- | --- | --- | --- | --- |
| `INVALID_ARGUMENT` | `input` | `false` | Неверный аргумент команды/вызова (пустая строка там, где нужна непустая). | Исправить аргумент, повторить. |
| `INVALID_CONFIG` | `config` | `false` | В `config.json` нет обязательного поля (например, `apkSize`). | Дописать конфиг, перезапустить. |
| `ACCOUNT_NOT_FOUND` | `state` | `false` | Аккаунт не найден по индексу/тегу/нику. | Уточнить запрос, проверить `accounts/`. |
| `ACCOUNT_LOCKED` | `state` | `true` | Аккаунт занят другим процессом (`*.lock`). | Подождать и повторить; не удалять lock вручную. |
| `STORE_CORRUPT` | `state` | `false` | Битый JSON в файле состояния (`Store.read`) или в аккаунте при скане. В `accounts/*` скан не падает: запись получает `error` + `errorCode`. | Восстановить файл/пересобрать индекс; для аккаунта — перелогин. |
| `STATE_ERROR` | `state` | `false` | Операция запрещена состоянием: `prune` не удаляет файл с `passToken`/`bindToken` или живой lock; в `Actions`/`Client` — конфликт состояния или отказ сервера (у отказа `kind: 'server'` и `details.serverCode`). | Ничего не делать: это защита от потери токена; для отказа сервера — сверить `details`. |
| `PERMISSION_DENIED` | `filesystem` | `false` | `EACCES`/`EPERM` при чтении/записи. | Выдать права или сменить каталог. |
| `FILESYSTEM_ERROR` | `filesystem` | `false` | Прочие ошибки ФС: `EIO`, `ENOSPC`, `ENOENT` при записи и т.п. | Проверить диск/путь; `EBUSY`/`EAGAIN`/`EMFILE` помечены `retryable`. |
| `NETWORK_ERROR` | `network` | `true` | Сеть недоступна, DNS/TLS, обрыв. | Повторить с задержкой или сменить прокси. |
| `TIMEOUT` | `timeout` | `true` | Нет ответа за отведённое время (в т.ч. туннель прокси). | Повторить; увеличить таймаут, если сервер медленный. |
| `PROXY_FAILED` | `network` | `true` | Прокси не принял соединение, отверг auth/CONNECT, вернул мусор, неверный URL прокси. | Взять следующий прокси из пула; проверить URL/логин. |
| `LICENSE_INVALID` | `auth` | `false` | `client-license.bin` короче 58 байт или хвост по смещению 56 выходит за файл. `details`: `file`, `expected`, `actual`, `reason` — без содержимого. | Переустановить APK/лицензию; файл не чинить вручную. |
| `PLATFORM_UNSUPPORTED` | `config` | `false` | Возможность недоступна на платформе (`supports(feature)` = `false`). | Выбрать другой режим/явно передать APK. |
| `PYTHON_MISSING` | `config` | `false` | `python3`/`python` не найден, а операция требует его (обновление из APK). | Установить Python и повторить. |
| `INTERNAL` | `internal` | `false` | Неизвестная ошибка, обёрнутая без кода. | Считать багом; логировать через `toJSON` и приложить `code`. |

### Коды Connect (исторические)

`lib/Connect.js` выбрасывает `ConnectError extends AppError`. Значения `err.code` не менялись —
на них завязаны внешние скрипты и `docs/CONNECT.md`:

| `code` | Константа | `kind` | `retryable` | Когда |
| --- | --- | --- | --- | --- |
| `validation` | `codes.CONNECT_VALIDATION` | `input` | `false` | Локальная проверка e-mail, PIN, bind-token, player-id. |
| `http` | `codes.CONNECT_HTTP` | `server` | `false`; `true` для 429/5xx | Сервер ответил не-2xx. `err.status` сохранён, `details.status` тоже. |
| `timeout` | `codes.CONNECT_TIMEOUT` | `timeout` | `true` | Upstream не ответил за таймаут. |
| `network` | `codes.CONNECT_NETWORK` | `network` | `true` | DNS/TLS/обрыв. |
| `json` | `codes.CONNECT_JSON` | `server` | `false` | Сервер объявил JSON, но тело не разобралось. |
| `auth` | `codes.CONNECT_AUTH` | `auth` | `false` | Зарезервирован для явных auth-ошибок; сейчас 401 приходит как `http` + `status: 401`. |

Сравнивать лучше через константы: `err.code === codes.CONNECT_HTTP`.

## `toJSON` — единственный безопасный способ логировать

```js
const { toJSON } = require('./lib/Errors');
console.error(JSON.stringify(toJSON(error)));
// { code, kind, retryable, message, details }
```

`toJSON` (и `JSON.stringify(error)` для `AppError`) не содержит стектрейса и вычищает секреты:
`passToken`, `token`, `bindToken`, `authorization`, `cookie`, `password`, `secret`, `apiKey` заменяются
на `***`, `email` маскируется (`a***@example.com`), буферы превращаются в `[binary N bytes]`,
циклы — в `[circular]`. E-mail и `Bearer`-строки в самом `message` тоже маскируются.
`ConnectError` дополнительно не печатает `data` (тело ответа сервера) и `status` остаётся в `details`.

## Пример обработки во внешнем скрипте

```js
const { codes, toJSON } = require('./lib/Errors');
const Connect = require('./lib/Connect');
const Accounts = require('./lib/Accounts');

async function main() {
  try {
    const account = Accounts.find(process.cwd(), '3');
    if (!account) throw new Error('аккаунт 3 не найден');
    await Connect.links();
  } catch (error) {
    if (error.code === codes.PROXY_FAILED || error.code === codes.NETWORK_ERROR) {
      // сеть/прокси: повторить или взять следующий прокси
    } else if (error.code === codes.CONNECT_HTTP && error.status === 401) {
      // токен протух: заново confirm
    } else if (error.code === codes.TIMEOUT) {
      // увеличить таймаут и повторить
    }
    console.error(JSON.stringify(toJSON(error)));
    process.exitCode = 1;
  }
}
```

Правило: **не парсить `message`**. Текст русский, он для человека и может меняться; `code`, `kind`,
`retryable`, `details` — контракт. Если нужен новый признак — добавляйте поле/код, а не регулярку по
сообщению.

## Как добавить новый код

1. Добавьте запись в `CATALOG` в `lib/Errors.js`: имя константы, `kind`, `retryable` (для Connect
   при необходимости `value` с историческим кодом).
2. Используйте `codes.НОВЫЙ_КОД` в месте возникновения, `details` — только несекретные данные.
3. Добавьте строку в таблицу этого файла и тест в `tests/errors.test.js`.
4. Не меняйте `message` существующих ошибок: внешние скрипты могут его печатать.

## Где применяется

| Модуль | Код | Когда |
| --- | --- | --- |
| `lib/Actions.js` | `INVALID_ARGUMENT` | Неизвестная команда, экспериментальная команда без `--experimental`, пустой/неизвестный регион, отсутствующий `--code`/`--mode`, несовпадение карты и режима, передача президентства без `--role president`. |
| `lib/Actions.js` | `STATE_ERROR` (`kind: 'server'`, `details.serverCode`) | Сервер ответил отказом: код заявки/региона/настройки клуба, `24129` с кодом команды, `ответ 24178/0` без подтверждения в Home. |
| `lib/Actions.js` | `STATE_ERROR` | Конфликт состояния: нет ожидающей заявки/приглашения, лобби не создано, бот не в сети, клуб/команда/рейтинг не разобраны, эмблема не подтверждена. |
| `lib/Client.js` | `INVALID_CONFIG` | `config.cryptoMode` не `nulls-native19`. |
| `lib/Client.js` | `INVALID_ARGUMENT` | `--age` и неверный `battleTransport` (`none|udp`). |
| `lib/Client.js` | `TIMEOUT` / `NETWORK_ERROR` | Этап входа не подтверждён за `connectTimeout`, нет данных 30 с, закрытие соединения, UDP-канал боя не поднялся. |
| `lib/Client.js` | `STATE_ERROR` (`kind: 'server'`) | Сервер отклонил вход (`LoginFailed`), отклонил действие (`errors` в `request`), `LoginOk` без данных аккаунта, «Соединение прервано; результат действия неизвестен», бот не в сети. |
| `lib/Client.js` | `PROXY_FAILED` | Пул прокси пуст. |
| `lib/CLI.js` | `INVALID_ARGUMENT` | Неизвестная команда/язык, нет `--name` при создании аккаунта. |
| `lib/CLI.js` | `STATE_ERROR` | `create-account` на занятом файле аккаунта, другой `--name` при уже заданном нике. |
| `lib/CLI.js` | `unconfirmed` (`kind: 'server'`) | `result.confirmed === false`: исторический код сохранён ради внешних скриптов (`docs/COMMANDS.md`), код возврата 2. |
| `lib/Fleet.js` | `slot.errorCode` / `slot.errorKind` | Текст `slot.error` прежний; рядом лежит машинная пара. Битый `accounts/bot-N.json` даёт `STORE_CORRUPT`, таймаут входа — `TIMEOUT`, отказ `Actions` — код его ошибки. |
| `lib/AccountLock.js` | `ACCOUNT_LOCKED` (`retryable: true`) | Lock занят живым процессом (`details.file`, `details.pid`) или его нельзя проверить; ошибки ФС идут как `PERMISSION_DENIED`/`FILESYSTEM_ERROR`. |
| `utils/AutoUpdate.js` | `PYTHON_MISSING`, `PLATFORM_UNSUPPORTED` | Нет `python3` для обновления из APK; пакет не установлен и `--apk` не передан. |
| `utils/AutoUpdate.js` | `INVALID_ARGUMENT` / `INVALID_CONFIG` / `STATE_ERROR` | Неверные флаги (`--interval`, `--rollback`), неподдерживаемый `cryptoMode`, изменённый `config.json`, отказ сервера на probe, чужой updater или `config.json` без обязательных полей. |

Коды возврата CLI: `0` — успех, `1` — ошибка (`kind` не `input`), `2` — ошибка аргументов (`kind: 'input'`)
или `confirmed: false`. `Program.js` без `--json` печатает `err.message` и сохраняет код `1`.

### Результаты `fleet` (`.runtime/results/*.json`)

- Отказ всей команды: `{ ok: false, error, code, kind, retryable }` — `error` по-прежнему текст.
- Результат по боту: `{ index, error, code, kind, retryable }` внутри `result[]`; `ok` остаётся `true`,
  потому что команда выполнена, а сбой относится к одному боту. Так родитель отличает сеть
  (`NETWORK_ERROR`/`PROXY_FAILED`, `retryable: true`) от отказа сервера (`STATE_ERROR`, `kind: 'server'`).

## Совместимость

- Коды и `message` не переименовываются и не удаляются без мажорной версии.
- Новые поля (`kind`, `retryable`, `details`, `cause`, `errorCode` у записей `Accounts.scan`) —
  аддитивны; старый код, который их не читает, продолжает работать.
- `lib/Store.read` по-прежнему возвращает `fallback`, если файла нет, и бросает ошибку на битом JSON;
  изменился только класс/код ошибки (`STORE_CORRUPT`), текст остался текстом `JSON.parse`.
- `utils/ProxyConnect` сохраняет прежние тексты (`Invalid proxy URL`, `HTTP proxy CONNECT rejected`,
  `SOCKS5 CONNECT rejected: N`), добавляя `code`/`kind`/`retryable`.
- `utils/Platform.pythonCommand()` по-прежнему возвращает `string | null` и не бросает;
  `requirePython()` — бросающая обёртка для кода, которому нужен запуск.