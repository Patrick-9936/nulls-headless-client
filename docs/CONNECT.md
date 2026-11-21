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

6. Отвязка. Симметрична `bind`: сначала `GET /games/unbind?bind_token=...&game=laser` с bearer, при `404`/`405` — один JSON-POST fallback. Endpoint **не подтверждён на живом upstream**: если после обоих методов сервер отвечает `404`/`405`/`501`, CLI завершается ошибкой `CONNECT_UNSUPPORTED` с текстом «сервер не поддерживает отвязку» и ничего не выдумывает про успех.

   ```sh
   node tools/connect.js unbind --account accounts/bot-1.json
   node tools/connect.js unbind --bind-token <jwt> --token <bearer>
   ```

7. Игровой токен конкретного игрока. По умолчанию печатаются только префикс и длина; полный токен — только с `--show-token`:

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

## Привязка сразу после входа: `--connect-bind`

Необязательный шаг для `node Program.js login` и `node Program.js create-account`:

```sh
node Program.js login --account accounts/bot-1.json --connect-bind
node Program.js login --account accounts/bot-1.json --connect-bind --connect-token <bearer>
```

После успешного входа, если у аккаунта уже есть `bindToken.token` из `LoginOk`, клиент вызывает `Connect.bind(...)` с bearer из `--connect-token` или из `.runtime/connect.json`. Результат добавляется в JSON-ответ полем `connectBind`:

- `{"ok": true, "status": 200, "data": {...}}` — привязка прошла; токены в `data` замаскированы;
- `{"skipped": true, "reason": "..."}` — привязка не выполнена. `reason`: `no-bind-token` (LoginOk не дал JWT), `no-bearer` (нет `--connect-token` и локального токена), `http`/`network`/`timeout`/`validation` (код ошибки Connect, плюс `status`/`message` для диагностики).

`skipped` **не делает вход неуспешным**: `confirmed` и `account` остаются такими, какими их вернул `login`, предупреждение уходит в `Debugger.warn` (stderr). Без флага шаг не выполняется вовсе и сеть для него не нужна; с флагом при отсутствии bearer или bind-token сеть тоже не трогается. Ни bearer, ни bind-token не логируются — только их наличие/длина.

## Формы `--json` в `tools/connect.js`

`tools/connect.js` понимает три формы вывода для всех команд (`pin`, `confirm`, `bind`, `unbind`, `links`, `token`, `status`, `logout`):

- `--json` — одна строка `{"ok":true,"result":{...}}`;
- `--json=false` (или `=0`/`=no`) — обычный pretty-JSON в несколько строк;
- без флага — тот же pretty-JSON.

Секретные поля (`token`, `bind_token`, `pin`, …) в выводе маскируются как `[скрыто, N символов]`; для `token` есть отдельный `--show-token`.

## Где лежит токен

`.runtime/connect.json` в корне репозитория, права `0600`, каталог `.runtime/` уже в `.gitignore`. Содержимое: `{email, token, at, game}`. Токен не печатается ни CLI, ни библиотекой; e-mail в логах маскируется как `a***@domain`. Путь можно переопределить переменной `NC_STATE_FILE` (нужно для тестов и нестандартных установок).

`lib/Connect.js` не логирует ни bearer, ни bind-token, ни query-строку с ними. Ошибки содержат только путь эндпоинта и HTTP-статус.

## Переменные окружения

- `NC_API_UPSTREAM` — база API Connect, по умолчанию `https://connect.nulls.gg/api`.
- `NC_PROFILES_UPSTREAM` — база профилей, по умолчанию `https://profiles.dnull.xyz`.
- `NC_STATE_FILE` — путь к локальному состоянию, по умолчанию `.runtime/connect.json`.

Хвостовые слэши в базах нормализуются. Значения читаются при загрузке модуля.

## Таймауты и повторы

Каждый запрос ограничен `AbortSignal.timeout` — 15 секунд по умолчанию, переопределяется опцией `timeout` на уровне библиотеки. Один повтор на 250 мс допускается только для идемпотентных GET (`links`, `gameToken`, `profile`) и только при сетевой ошибке. Таймаут, HTTP-ошибка и ошибка JSON не повторяются. `requestPin` и `confirmPin` не повторяются: первая отправляет письмо, вторая меняет состояние логина. У `bind` есть один документированный fallback: если GET отвечает 404/405, тот же вызов уходит JSON-телом через POST. `unbind` устроен так же (fallback тоже на 404/405), но его endpoint на живом upstream не подтверждён: если и POST отвергнут с 404/405/501 (или GET сразу вернул 501), клиент бросает `CONNECT_UNSUPPORTED`.

## Типовые ошибки

| Код (`error.code`) | Что значит |
| --- | --- |
| `validation` | Локальная проверка: пустой e-mail или без `@`, PIN не 4–8 цифр, пустой bind-token, нет bearer-токена, нет `--player-id`. |
| `http` + `error.status = 401` | Неверный или просроченный PIN либо bearer. Запросите PIN заново и повторите `confirm`. |
| `http` + `status = 404` | Для `bind` — неизвестный bind-token или эндпоинт ответил только на POST (fallback уже сделан). Для `pin` без `can_register` сервер отвечает «no account associated with your email»; в CLI `can_register` включён по умолчанию. |
| `timeout` | Upstream не ответил за отведённое время. |
| `network` | DNS, TLS, обрыв соединения, недоступный upstream. |
| `json` | Сервер объявил JSON в `content-type`, но тело не разобралось. |
| `CONNECT_UNSUPPORTED` | Отвязка: `/games/unbind` не принял ни GET, ни POST (404/405/501). Значит, сервер не поддерживает отвязку — локально ничего не меняется. |

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
| 40 | 2 × `optional string` | обе отсутствуют (`0xffffffff`) |
| 48 | `u32` clientMajor | 69 |
| 52 | `u32` contentVersion | 414 |
| 56 | `u32` | 1 |
| 60 | `string` environment | `prod` |
| 68 | 3 × `u32` | 1, 1, 1 |
| 80 | `string` buildTag | `103121310241222` |
| 107 | `string` serverTime | `1795249192` |
| 121 | `string` secondaryTime | `1795249191` |
| 135 | `u32` | 0 |
| 139 | `i32` | −1 |
| 143 | `string` countryCode | `RU` |
| 149 | `i32`, `u32`, `i32` | −1, 1, −1 |
| 161 | `u32` patchUrlCount + строки | 2 |
| 241 | `u32` eventUrlCount + строки | 2 |
| 323 | `VInt` tokenBlobMode | 0 во всех захватах |
| 324 | `i32` BE tokenBlobLength | 4 + длина zlib-потока |
| 328 | blob: `u32 LE` tokenRawLength + zlib | JWT 149 байт |

Смещения даны для захвата с 2 URL и 20-символьным passToken; дальше они сдвигаются вместе
с длинами строк. Claims живого токена: `{"game":"laser","bind":true,"pid":"280648723","exp":…}`.
`pid` совпадает с `accountId.lo`, срок — сутки; на каждом входе выдаётся новый токен,
поэтому `bind` берёт свежий из последнего `LoginOk`.

## Хвост LoginOk: сжатая строка с JWT (расшифровано)

Хвост пакета — не «VInt + padding», а одна структура «сжатая строка», как её читает клиент:

```
VInt   tokenBlobMode          0 (поле объекта +0x154, клиент его не интерпретирует)
i32 BE tokenBlobLength        ровно 4 + длина zlib-потока
blob[tokenBlobLength]:
  u32 LE tokenRawLength       длина распакованного JWT (149 в живых захватах)
  zlib-поток                  78 9c … (ровно tokenBlobLength - 4 байт)
```

Доказательство из установленного APK (`base.apk` → `lib/arm64-v8a/libg.so`, декодер
`LoginOk`; id сообщения 0x4E88 = 20104 возвращает геттер `0xf2d390`, версия 1 — `0xf2d398`,
кодек — функция `0xf2cd80`):

- `0xf2d130` — `readVInt` (байткод `bl 0x5b7fc4`), результат в поле объекта `+0x154`;
- `0xf2d148` — `bl 0x5fa58c`: внутри `vtable+0x140` читает 4-байтную длину, `vtable+0x148`
  читает ровно столько байт (лимит 900000) — это `int32 len` + `blob[len]`;
- `0x5fa69c` — разбор первых 4 байт blob как **u32 little-endian**
  (`ldrh [x0]`, `byte2 << 16`, `byte3 << 24`), затем `0x5fa714 bl 0x1183cb4(dst, &size, blob+4, len-4)`;
- `0x1183cb4` → `0x1183b04` → `0x117e808` с аргументом-версией по строке `"1.3.1"` (`0x1a092e`) —
  это zlib 1.3.1 `uncompress`/`inflateInit2_`.

Восемь живых захватов (`brawl.server.dnull.xyz:9339`, гости создавались в копии дерева)
подтверждают ту же раскладку: `tokenBlobMode = 0`; `tokenBlobLength ∈ {148, 149, 151}` и
всегда равно 4 + длине потока (144/145/147); `tokenRawLength = 149`, распаковка даёт ровно
149 байт; поток начинается с `78 9c`. Значение `1365/1366` в старой раскладке — артефакт
смещения на один байт: парсер читал `u32 0` вместо `VInt 0`, после чего `0x97 0x95`
склеивались в «VInt», а `u32`-длина blob сдвигалась. Именно поэтому у старой раскладки
`VInt − compressed` было постоянным: оба числа описывали одно и то же поле с разным
смещением.

Поля после blob в клиенте (`+0x150`, `+0x151` — два boolean, затем до трёх optional-строк
`+0x120`, `+0x158`, `+0x128`) в живых пакетах не встречаются: сразу за blob идёт padding
транспорта (`00 ff…ff 00`), и клиентские чтения обрываются по длине.

## Что подтверждено, а что эвристика

- HTTP-контракт Connect (`/auth/login.v2`, `/games/bind`, `/games/links`, `/games/token`, `/games/bind` через POST-fallback) взят из открытого PR #4 и комментариев в нём.
- `/games/unbind` **не подтверждён на живом upstream**: путь и форма запроса выбраны симметрично `bind` (GET с `bind_token`/`game`, POST-JSON на 404/405), но в PR его не было. Поэтому «сервер не поддерживает отвязку» — ожидаемый, а не исключительный исход; проверять на живом сервере.
- Извлечение bind-token из `LoginOk` **подтверждено на живом сервере**: восемь пакетов 69.252, новые гости, все содержат сжатый JWT. Фикстуры в `tests/fixtures/login-ok-69*.bin` обезличены (структура и длины настоящие, токен синтетический), разбор закреплён `tests/login-ok.test.js`. Хвост расшифрован по декодеру `LoginOk` в libg.so (`0xf2cd80`, см. раздел о хвосте): `VInt mode`, `int32` BE длина blob, внутри `u32 LE` длина распакованного JWT и zlib-поток. Поля `+0x150/+0x151` и optional-строки после blob в живых пакетах не встречаются.
- `profile()` и `updateProfile()` в библиотеке повторяют вызовы profiles-прокси из PR, но в CLI не выведены и на живом сервере здесь не проверялись.