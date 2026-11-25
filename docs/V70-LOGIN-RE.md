# v70 login — реверс из `libg.so` (32-bit ARM, стоковый Nulls-клиент)

Снято статическим дизассемблером из `libg.so` (ELF32 ARM, stripped, build-id
`d33a92c8…`), сверено с живыми pcap-дампами. Это **истина по проводу**, а не
эмуляция. Весь разбор — read-only, без рута и без модификации APK.

## Карта (адреса — RVA, первый LOAD: RVA == file offset)

| узел | адрес | факт |
|---|---|---|
| строка `invalid_files_content_update` | `0x1502a6` | реальная строка в libg (подтверждает прежний `loginContentFp`) |
| ClientHello vtable | `0x11ce1b8` | `getMessageType` (vtable+0x14) → `0x2774` = 10100 |
| ClientHello `encode` | `0x962ec0` | 9 полей; большая строка-поле = key+license-блоб → это и есть 776-байтный hello |
| **LoginMessage vtable** | `0x11ea968` | `getMessageType` (vtable+0x14, `0x963174`) → **`0x2775` = 10101** |
| **LoginMessage `encode`** | **`0xe464e8`** | **34 поля** (ниже) |
| LoginMessage `decode` | `0xe46698` | slot[3] |
| ctor LoginMessage | `~0xe46330` | ставит vptr `0x11ea970` |

## Примитивы записи (ByteStream/ChecksumEncoder)

| writer | смысл | в терминах `DataStream/ByteStream.js` |
|---|---|---|
| `0x311ec8`→`0x2904fc` | LogicLong: пишет два элемента (hi, lo) через `vtable+0x28` | `writeVInt(hi); writeVInt(lo)` |
| `0x310614` (резерв 4 Б) | **Int32** (fixed big-endian) | `writeInt` |
| `0x310f1c` (резерв 5 Б) | **VInt** (Brawl zig-zag) | `writeVInt` |
| `0x30fdb4` | std::string (длина Int32 + байты) | `writeRequiredString` |
| `0x30ff84` | nullable-строка (null → длина `0xffffffff`) | `writeOptionalString` |
| `0x3103b4` | один байт | `writeBoolean` |
| `0xefd520` | nullable-ссылка (пусто → 0) | ~ `writeDataReference` / optional |
| `0x358ddc` | 64-бит через vtable (ещё один LogicLong) | `writeLong`/`writeVInt×2` |

> Длины строк в этом протоколе — **4-байтный Int32**, а не VInt: это видно прямо
> в plaintext-дампе ClientHello (`00 00 00 28` = длина 40 перед SHA1). Клиентский
> `writeRequiredString` (4-байтная длина) этому соответствует.

## Порядок полей `Login::encode` (0xe464e8), как на проводе

| # | смещение в объекте | writer | тип | вероятный смысл |
|---|---|---|---|---|
| 1 | +0x80 | 0x311ec8 | LogicLong (VInt hi, VInt lo) | **accountId (hi, lo)** |
| 2 | +0x84 | 0x30ff84 | OptionalString | **passToken** |
| 3 | +0x88 | 0x310614 | Int32 | **clientMajor** |
| 4 | — | 0x310614 | Int32 = **1** (литерал) | const 1 |
| 5 | +0x8c | 0x310614 | Int32 | **clientBuild** |
| 6 | +0xa0 | 0x30ff84 | OptionalString | masterHash / fingerprint |
| 7 | +0xa4 | 0x30ff84 | OptionalString | (device / пусто) |
| 8 | +0xb8 | 0xefd520 | nullable-ref | DataReference-подобное (0) |
| 9 | +0xa8 | 0x30ff84 | OptionalString | |
| 10 | +0xbc | 0x30ff84 | OptionalString | |
| 11 | +0xec | 0x3103b4 | Boolean | |
| 12 | +0xc0 | 0x30fdb4 | RequiredString | |
| 13 | +0xd0 | 0x30fdb4 | RequiredString | |
| 14 | +0xed | 0x3103b4 | Boolean | |
| 15 | +0xe0 | 0x30ff84 | OptionalString | |
| 16 | +0xe8 | 0x310614 | Int32 | |
| 17 | +0xe4 | 0x310f1c | VInt | |
| 18 | +0x90 | 0x30fdb4 | RequiredString | |
| 19 | +0xf0 | 0x30fdb4 | RequiredString | |
| 20 | +0x100 | 0x30fdb4 | RequiredString | |
| 21 | +0x110 | 0x310f1c | VInt | |
| 22 | +0x118 | 0x30fdb4 | RequiredString | |
| 23 | +0x128 | 0x30fdb4 | RequiredString | |
| 24 | +0x138 | 0x30fdb4 | RequiredString | |
| 25 | +0x114 | 0x358ddc | LogicLong/64-бит | |
| 26 | +0x148 | 0x3103b4 | Boolean | |
| 27 | +0x14c | 0x30fdb4 | RequiredString | |
| 28 | +0x15c | 0x30fdb4 | RequiredString | |
| 29 | +0x16c | 0x30fdb4 | RequiredString | |
| 30 | +0x17c | 0x30fdb4 | RequiredString | |
| 31 | +0x18c | 0x30fdb4 | RequiredString | |
| 32 | +0x19c | 0x30fdb4 | RequiredString | |
| 33 | +0x5c | 0x30fdb4 | RequiredString | |
| 34 | +0x6c | 0x30fdb4 | RequiredString | |

## Главный вывод (вероятная причина отказа)

1. **accountId** реальный клиент пишет как **LogicLong = `VInt(hi); VInt(lo)`**
   (поле 1). Текущий клиент пишет `writeInt(hi); writeInt(lo)` = **два Int32 по 4
   байта**. Если реальность — VInt, то первые же байты тела иной длины, и весь
   разбор на сервере рассыпается → молчаливый FIN. Это кандидат №1.
2. Далее порядок/типы в целом близки (token, major, const 1, build, optstr,
   optstr, dataref…), но в середине/хвосте расходятся: реальный encode имеет
   второй LogicLong (+0x114, поле 25) и иной набор строк/булей, тогда как текущий
   клиент в этих позициях шлёт `writeOptionalByteArray` и другой порядок пустых
   строк.

Длина тела в живом дампе (261 Б с токеном) совпадает с этой 34-полевой
раскладкой — структура та же, расходятся **типы отдельных полей и порядок хвоста**.

## Что из этого следует для фикса

Сервер молчит, пока тело не разберётся целиком. Значит цель — привести
`LoginMessage.encode` к **этому** порядку и типам байт-в-байт. Как только
структура сойдётся, сервер ответит (LoginOk либо LoginFailed с кодом — это уже
различимый сигнал). `tools/login-probe.js` ловит именно этот переход
`SILENT → REPLY/OK`.

Профиль `config.loginBodyProfile = "libwire"` (см. `LoginMessage.js`) — попытка
воспроизвести эту раскладку. Значения части хвостовых полей ещё уточняются по
функции-populate; структура (порядок + типы) взята из `encode` напрямую.

---

# Прогон probe 25.11 — тело исключено как причина

`login-probe.js --sweep` по account 0/280654299 против живого сервера:
**все 30 комбинаций** (layout native/hello × body libwire/native70/legacy69 ×
conn 0/1448/1/70/877) → **SILENT**. Важно: это `SILENT`, а не `NOHELLO`, то есть
`ServerHello` приходит, логин уходит, и сервер молча закрывает сокет.

Вывод, меняющий всё: **тело логина — не причина отказа.**

- Даже `libwire` — побайтовая раскладка из самого `Login::encode` — закрывается.
- Даже `hello` — крипто-раскладка, которой v69 проходил live-verified — закрывается.
- Значение `+0x13c` (connection) ни при каком из 5 кандидатов не помогает.

Раз корректная по структуре тело всё равно отбрасывается, блокер — на уровне
**крипто/конверта или проверки до тела** (ключ/nonce/лицензия/аккаунт), а не в
содержимом тела. Это разворачивает всю прежнюю работу (804 id, 32 комбинации
тела и т.д. били не по тому слою).

## Зацепка: серверный публичный ключ

`config.serverPublicKeyHex` (`656AA590…0E8656`, keyVersion 60) **в `libg.so`
отсутствует** — нет даже первых 8 байт. В нативной либе ключ не захардкожен: его
подаёт Java-слой/ассеты APK в рантайме через JNI. Значит проверить/взять
правильный ключ нужно из APK (assets или smali/dex, который настраивает нативную
крипту), а не из `libg.so`.

Кандидат №1 в причину: наш серверный ключ (или keyVersion) не тот, что ждёт v70-
сервер, — тогда box шифруется «не туда», сервер не может расшифровать и молча
роняет логин при любом теле. Это ровно тот симптом, что мы видим.
