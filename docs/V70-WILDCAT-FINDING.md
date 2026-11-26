# v70 login — настоящий блокер: Wildcat anti-cheat (не крипта)

## Итог сессии (на телефоне, против живого сервера)

1. **Крипта логина РЕШЕНА.** `tools/v70-engine/` (эмулятор libg64.so в Unicorn)
   воспроизводит реальный seal байт-в-байт. Ключ сервера `656AA5…` — зашит в
   lib (подтверждено: seal игнорирует переданный pk, берёт встроенный).
2. **Настоящий игровой сервер — `nb.nullsproxy.com`** (→ 62.233.36.73/.74), а НЕ
   `brawl.server.dnull.xyz` (= 135.125.37.166, устаревший). Config.host исправлен.
3. **Логин всё равно молча дропается** при полном совпадении: крипта, сервер,
   версия 70.877, fingerprint 7a43eaf, ClientHello (реальные байты), структура
   `[VInt len][body][clientNonce]`, реальный аккаунт, 6 раскладок plaintext,
   burst — ВСЁ молчит. Сервер отвечает LoginFailed(код) на плохой ClientHello,
   но на наш валидный логин — тихий FIN.

## Причина (из pcap реального клиента)

Реальный клиент ПЕРЕД логином делает:
```
GET https://wildcat-api.royalegame.win/v2/script/daniillnull.nulls.brawlstars/70.877/release?client_pk=<32-байтный pubkey>
→ 200, application/octet-stream, 138555 байт бинарного «скрипта»
```
Это **Wildcat anti-cheat**: сервер отдаёт пер-сессионную ПОЛИМОРФНУЮ 138КБ
программу, которую `libwildcat.so` (8.7 МБ, в APK) исполняет и выдаёт integrity-
токен. Токен кладётся в блоб ClientHello (реальный блоб = 599 байт бинарь + JSON
`{"features":…,"timestamp":…,"modificationIds":[…]}`) и валидируется игровым
сервером при логине. Наш клиент шлёт статический `client-license.bin` → сервер
видит невалидный токен → молча рвёт логин.

Домены в деле: `wildcat-api.royalegame.win` (выдаёт скрипт), `nb.nullsproxy.com`
(игровой сервер), `profiles.dnull.xyz`, `ext.nulls.gg`, `sentry.dnull.xyz`.

## Что это значит

«Ошибка 10101» для headless-клиента — это НЕ баг крипты (крипту мы вскрыли), а
**целевая анти-бот защита**. Чтобы залогиниться, клиент обязан:
1. Сгенерировать wildcat-ключ, скачать 138КБ скрипт с wildcat-api.
2. Исполнить его через `libwildcat.so` (нативно на устройстве или в эмуляторе) →
   integrity-токен.
3. Положить токен в блоб ClientHello.

Путь реален (запустить libwildcat на телефоне, как это делает
`AndroidChallengeBridge` через app_process, либо эмулировать в Unicorn), но это
отдельная большая задача по реверсу анти-чита, и сервер может менять VM/скрипт.

---

## Разбор Wildcat (сессия продолжение) — что делает скрипт

Из прошлого реверса (`~/nulls-client-scripts/brawl-69.252/`, Frida-дамп QuickJS
`/bs-new-epoch.js`, 212 функций, читаемый JS) установлен механизм Wildcat. v70-
скрипт (`~/wildcat_script_v70.bin`, 138555 Б) зашифрован (заголовок `00021d37`),
но механика v70 та же:

1. **ClientHello-блоб = `license || JSON`** (патч `ClientHelloMessage::encode`,
   make_138). JSON = `{features:[high/low_memory по getMemory()≷3400], timestamp:
   Date.now(), connection:"Keep-Alive", modificationIds:[...]}`. `license` —
   СТАТИЧНЫЙ бинарь из APK (`lib/vmprot/…`, парсится как ZIP/подготовленный .so),
   один на версию.
2. **LoginMessage-патч (make_139)** пишет только `apkSize ^ 4330295` (seed) в
   объект по смещению `+0x138` перед encode. `config.apkSize` у нас ВЕРНЫЙ
   (= размер base.apk 1360688785 → seed 1364747686).
3. **`wildcat_js_request({type:"setLicense", clientData})`** — нативный мост в
   libwildcat/NTTitan: отдаёт `clientData` (из APK) и получает `modificationIds`.

### Подтверждённые факты на живом сервере (62.233.36.73 / nb.nullsproxy.com)

- Реальный клиент логинится: `ClientHello(815) → ServerHello(32) → Login(332) →
  LoginOk(562)`, затем игровые кадры. Клиент шлёт ClientHello+Login+сообщения
  ОДНИМ залпом (до ServerHello).
- Наш `client-license.bin` (595 Б) ≠ реальный license (599 Б, `daab21d8…`).
  Реальный сохранён в `client-license.bin.v70real`.
- Тест «реальный ClientHello (реальный license) + наш engine-логин» → всё равно
  тихий дроп. Значит license — не единственная проблема; **тело логина** тоже не
  совпадает байт-в-байт (наши профили native70/libwire/legacy69 дают 261/252/269 Б,
  реальное тело ≈ 258 Б — ни один не сходится точно).

### Что нужно для рабочего логина (оставшееся)

Собрать ТОЧНЫЙ ClientHello-блоб и тело логина как у реального клиента. Надёжный
путь — прогнать связку libg.so + libwildcat.so (нативно на устройстве через
app_process/dlopen, как `AndroidChallengeBridge`, либо в эмуляторе/Codespace) на
138КБ скрипте, снять готовые `license`/`clientData` и тело `Login::encode`.
Адрес `Login::encode` для v70 в native-bindings отсутствует (там v69 `0xf2bc3c`);
его надо заново найти по vtable (getMessageType → `mov w0,#0x2775`).
