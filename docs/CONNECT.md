# Nulls Connect

Nulls Connect — внешняя идентификация Nulls: пользователь подтверждает e-mail PIN-кодом, получает bearer-токен и привязывает к этой личности игровые аккаунты. Привязка (`bind`) нужна, чтобы один e-mail управлял несколькими игровыми аккаунтами: серверу предъявляется JWT, который игровой сервер выдал аккаунту в пакете `LoginOk`, и Connect запоминает связь. Дальше через Connect можно смотреть привязанные аккаунты (`links`) и получать для них игровые токены (`gameToken`).

Код: `lib/Connect.js` (HTTP-клиент), `tools/connect.js` (CLI), извлечение JWT из `LoginOk` — `Messaging/Messages/Server/LoginOkMessage.js`.

## Полный цикл

1. PIN на e-mail. Клиент делает `GET /auth/login.v2?email=...&game=laser&locale=ru&can_register=true`; сервер отправляет PIN письмом. `can_register=true` создаёт личность, если адреса ещё нет в Connect.

   ```sh
   node tools/connect.js pin --email user@example.com --locale ru --game laser
   ```

2. Подтверждение PIN. Тот же эндпоинт с `pin=...` возвращает `{token}` — это bearer Nulls Connect. Токен сохраняется локально, в выводе показывается только маскированный e-mail.

   ```sh
   node tools/connect.js confirm --email user@example.com --pin 1234
   ```

3. Вход игрового аккаунта обычным клиентом. Сервер отдаёт в `LoginOk` bind-token; клиент сохраняет его в файл аккаунта:

   ```sh
   node Program.js login --account accounts/bot-1.json
   ```

   В `accounts/bot-1.json` появляется `bindToken: {token, at}`. Сам токен в логи не пишется, только его длина.

4. Привязка. CLI берёт bind-token из аккаунта или из `--bind-token`, а bearer — из `--token` или `.runtime/connect.json`:

   ```sh
   node tools/connect.js bind --account accounts/bot-1.json
   node tools/connect.js bind --bind-token <jwt> --token <bearer>
   ```

5. Список привязанных аккаунтов:

   ```sh
   node tools/connect.js links
   ```

6. Игровой токен конкретного игрока. По умолчанию печатаются только префикс и длина; полный токен — только с `--show-token`:

   ```sh
   node tools/connect.js token --player-id 123456
   node tools/connect.js token --player-id 123456 --show-token
   ```

Служебные команды:

```sh
node tools/connect.js status   # есть ли токен, маскированный e-mail, дата; сеть не нужна
node tools/connect.js logout   # удалить локальный токен
node tools/connect.js --help
```

`logout` удаляет только локальный файл. Серверный токен при этом не отзывается: если он скомпрометирован, отзывайте его на стороне Connect.

## Где лежит токен

`.runtime/connect.json` в корне репозитория, права `0600`, каталог `.runtime/` уже в `.gitignore`. Содержимое: `{email, token, at, game}`. Токен не печатается ни CLI, ни библиотекой; e-mail в логах маскируется как `a***@domain`. Путь можно переопределить переменной `NC_STATE_FILE` (нужно для тестов и нестандартных установок).

`lib/Connect.js` не логирует ни bearer, ни bind-token, ни query-строку с ними. Ошибки содержат только путь эндпоинта и HTTP-статус.

## Переменные окружения

- `NC_API_UPSTREAM` — база API Connect, по умолчанию `https://connect.nulls.gg/api`.
- `NC_PROFILES_UPSTREAM` — база профилей, по умолчанию `https://profiles.dnull.xyz`.
- `NC_STATE_FILE` — путь к локальному состоянию, по умолчанию `.runtime/connect.json`.

Хвостовые слэши в базах нормализуются. Значения читаются при загрузке модуля.

## Таймауты и повторы

Каждый запрос ограничен `AbortSignal.timeout` — 15 секунд по умолчанию, переопределяется опцией `timeout` на уровне библиотеки. Один повтор на 250 мс допускается только для идемпотентных GET (`links`, `gameToken`, `profile`) и только при сетевой ошибке. Таймаут, HTTP-ошибка и ошибка JSON не повторяются. `requestPin` и `confirmPin` не повторяются: первая отправляет письмо, вторая меняет состояние логина. У `bind` есть один документированный fallback: если GET отвечает 404/405, тот же вызов уходит JSON-телом через POST.

## Типовые ошибки

| Код (`error.code`) | Что значит |
| --- | --- |
| `validation` | Локальная проверка: пустой e-mail или без `@`, PIN не 4–8 цифр, пустой bind-token, нет bearer-токена, нет `--player-id`. |
| `http` + `error.status = 401` | Неверный или просроченный PIN либо bearer. Запросите PIN заново и повторите `confirm`. |
| `http` + `status = 404` | Для `bind` — неизвестный bind-token или эндпоинт ответил только на POST (fallback уже сделан). Для `pin` без `can_register` сервер отвечает «no account associated with your email»; в CLI `can_register` включён по умолчанию. |
| `timeout` | Upstream не ответил за отведённое время. |
| `network` | DNS, TLS, обрыв соединения, недоступный upstream. |
| `json` | Сервер объявил JSON в `content-type`, но тело не разобралось. |

CLI печатает ошибку в stderr и выходит с кодом `1`; ошибки аргументов — код `2`; успех — `0`.

## Раскладка `LoginOk` 69.252 (снято с живого сервера)

JWT лежит **не открытым текстом**, а в zlib-потоке в конце пакета — поэтому ASCII-поиск
в 0.3.0 на живом сервере ничего не находил. Пакет разбирается по точной раскладке
(`layout: 'nulls-69'` в `LoginOkMessage`), поля идут без VInt-заголовка:

| Смещение | Поле | Значение в захвате |
|---:|---|---|
| 0 | `u32` accountId.hi | 0 |
| 4 | `u32` accountId.lo | 280648723 |
| 8 | `u32` homeId.hi | 0 |
| 12 | `u32` homeId.lo | 280648723 |
| 16 | `string` passToken | `jpF6veey1+CHayqfy9/q` |
| 36 | 8 байт неизвестного id | `-1:-1` |
| 44 | `u32` clientMajor | 69 |
| 48 | `u32` contentVersion | 414 |
| 52 | `u32` | 1 |
| 56 | `string` environment | `prod` |
| 60 | 3 × `u32` | 1, 1, 1 |
| 72 | `string` buildTag | `103121310241222` |
| 99 | `string` serverTime | `1795249192` |
| 113 | `string` secondaryTime | `1795249191` |
| 127 | `u32` | 0 |
| 131 | `i32` | −1 |
| 135 | `string` countryCode | `RU` |
| 141 | `i32`, `u32`, `i32` | −1, 1, −1 |
| 153 | `u32` patchUrlCount + строки | 2 |
| 233 | `u32` eventUrlCount + строки | 2 |
| 315 | `u32` | 0 |
| 319 | `VInt` (не расшифровано) | 1365 / 1366 |
| 323 | `u16` | 0 |
| 324 → конец | zlib-поток, `78 9c` | JWT, 149 байт |

Claims живого токена: `{"game":"laser","bind":true,"pid":"280648723","exp":…}`. `pid`
совпадает с `accountId.lo`, срок — сутки; на каждом входе выдаётся новый токен, поэтому
`bind` берёт свежий из последнего `LoginOk`. Поток последний в пакете, его длина не
закодирована — парсер проверяет маркер `78 9c` и распаковку, а не доверяет префиксу.

## Что подтверждено, а что эвристика

- HTTP-контракт Connect (`/auth/login.v2`, `/games/bind`, `/games/links`, `/games/token`, `/games/bind` через POST-fallback) взят из открытого PR #4 и комментариев в нём.
- Извлечение bind-token из `LoginOk` **подтверждено на живом сервере**: два пакета 69.252, новый гость, оба содержат zlib-JWT. Фикстуры в `tests/fixtures/login-ok-69*.bin` обезличены (структура настоящая, токен синтетический), разбор закреплён `tests/login-ok.test.js`. Поля `VInt` по смещению 319 и `u16` по 323 не расшифрованы: значения стабильны (1365/1366 и 0), парсер их не использует для поиска токена.
- `profile()` и `updateProfile()` в библиотеке повторяют вызовы profiles-прокси из PR, но в CLI не выведены и на живом сервере здесь не проверялись.
- `profile()` и `updateProfile()` в библиотеке повторяют вызовы profiles-прокси из PR, но в CLI не выведены и на живом сервере здесь не проверялись.