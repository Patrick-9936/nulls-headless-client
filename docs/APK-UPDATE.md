# Обновление под новый APK

Практический рецепт: что менять в `config.json`, когда выходит новый APK Nulls
Brawl, откуда берётся каждое поле и как убедиться, что клиент снова входит.

## 1. Откуда берутся поля `config.json`

| Поле | Источник |
| --- | --- |
| `appBinaryVersion` | `versionName` из `aapt2 dump badging base.apk`, формат `X.Y` (например `69.252`) |
| `clientMajor`, `clientMinor`, `clientBuild` | из того же `versionName`: `X` → `clientMajor`, `0` → `clientMinor`, `Y` → `clientBuild` |
| `major`, `minor`, `build` | версия **контента** из серверного fingerprint (`X.Y.Z`), не версия APK |
| `fingerprintHash` | `sha` из того же fingerprint, 40 hex-символов |
| `apkSize` | размер файла `base.apk` в байтах |
| `clientLicensePath` | путь к извлечённому блоку лицензии, обычно `client-license.bin` |
| `protocolVersion`, `keyVersion` | константы ClientHello, вытаскиваются из `libg.so` |
| `serverPublicKeyHex` | публичный ключ сервера, маркер SPK внутри `libg.so` |
| `packetIds` | ID пакетов; при смене протокола их приходится перепроверять |

Автообновление (`node tools/update.js`) меняет ровно этот набор полей
(`appBinaryVersion`, `clientMajor`, `clientMinor`, `clientBuild`, `major`,
`minor`, `build`, `fingerprintHash`, `protocolVersion`, `keyVersion`,
`serverPublicKeyHex`, `apkSize`, `clientLicensePath`) и ничего больше.

## 2. Блок лицензии из APK

Лицензия лежит не в assets, а в APK Signing Block: запись с ID `0x544e3713`.
`tools/extract_update_apk.py` читает ZIP end record, находит signing block,
проверяет размеры и вырезает эту запись в `client-license.bin`.

Формат блока:

- минимум 58 байт;
- по смещению 56 — `uint16LE` длина хвоста;
- хвост должен целиком помещаться в файл: `длина_хвоста <= размер_файла - 58`.

Именно эту проверку делает `utils/NullsLicense.apply`:

```js
if (license.length < 58 || license.readUInt16LE(56) > license.length - 58)
  throw new Error('Invalid installed Nulls APK license block');
```

Дальше там же считается seed входа:

```js
config.loginClientSeed = (config.apkSize ^ 4330295) | 0;
```

`loginClientSeed` в `config.json` не хранится — он пересчитывается при каждом
запуске из `apkSize`. Поэтому `apkSize` обязан быть размером того самого
`base.apk`, из которого взят блок лицензии. Блок и размер — пара: чужой размер
или блок от другой сборки дают отказ сервера.

## 3. Инструменты в репозитории

- `tools/extract_update_apk.py` — читает `base.apk` и optional ARM64-сплит,
  достаёт `libg.so`, `assets/fingerprint.json` и блок лицензии. Требует
  `aapt2` в `PATH`, проверяет имя пакета (`daniillnull.nulls.brawlstars`),
  пишет `client-license.bin` и отдаёт JSON с `appVersion`, `apkSize`,
  `licensePath`.
- `tools/update.js` → `utils/AutoUpdate.js` — весь цикл: блокировка
  `.updates/update.lock`, чтение APK, кандидат конфига, серверный fingerprint,
  проверка входа, атомарная запись `config.json`, бэкап в `.updates/backups/`.
- `utils/UpdateTransport.js` — ClientHello/Login по TCP, fingerprint-проба и
  проверка `LoginOk` + `OwnHomeData`.
- `utils/FingerprintProbe.js` — разбор ответа `status=7`: версия контента и
  `sha`, при сжатом fingerprint — `zlib.inflateSync`.
- `utils/LibgInspector.js` — SPK-ключ и константы hello из `libg.so`.

## 4. Порядок обновления

1. Поставить новый APK на устройство (или положить файлы рядом) и проверить,
   что видит апдейтер:

   ```sh
   node tools/update.js --check
   ```

   `--check` ничего не пишет: печатает `status: update-available|up-to-date`,
   версии APK и контента и список изменившихся полей.

2. Если APK не установлен, указать файлы явно:

   ```sh
   node tools/update.js --check \
     --apk /path/base.apk \
     --split-apk /path/split_config.arm64_v8a.apk
   ```

   `--split-apk` нужен, когда `libg.so` лежит в сплите, а не в base.

3. Применить изменения (полная проверка входа требует сохранённого аккаунта):

   ```sh
   node tools/update.js --account accounts/bot-1.json
   ```

   Апдейтер сам сделает бэкап `config.json`, проверит ClientHello, LoginOk и
   OwnHomeData и только потом запишет конфиг. При любой ошибке конфиг остаётся
   прежним.

4. Если APK лежит на устройстве, но обновлять конфиг вручную удобнее, шаги те
   же, что делает апдейтер:

   - `appBinaryVersion` — `versionName` из `aapt2 dump badging base.apk`;
   - `clientMajor`/`clientMinor`/`clientBuild` — `X`/`0`/`Y` из него же;
   - `apkSize` — `stat -c %s base.apk` (на Termux `stat -c %s`);
   - `client-license.bin` — заново вырезать блок `0x544e3713` и положить рядом
     с `config.json`, `clientLicensePath` оставить относительным;
   - `major`/`minor`/`build` и `fingerprintHash` — из ответа fingerprint-пробы
     (`node tools/update.js --check` печатает их в отчёте);
   - `protocolVersion`/`keyVersion`/`serverPublicKeyHex` — обновить, если
     `libg.so` изменился;
   - `packetIds` — если после обновления сервер молчит или отвечает не теми
     ID, сверить карту в `PROTOCOL-MAP.md` и `docs/protocol-evidence.json`.

5. Пересобрать бандл, потому что `Nulls.js` хранит копию исходников и
   `config.json`. В архив и бандл попадают только production-зависимости
   (`blakejs`, `colors`, `tweetnacl`); devDependencies (`eslint`, `globals`, `prettier`) в
   релиз не идут, ставить их для сборки не нужно:

   ```sh
   npm run bundle
   npm run bundle:check
   ```

6. Проверить:

   ```sh
   node Program.js info
   node Program.js features
   npm run lint
   node Nulls.js --self-test
   node Program.js login --account accounts/bot-1.json
   ```

   `info` показывает версию, хост, `appBinaryVersion` и версию контента;
   `features` — что реально проверено; `lint` — eslint без ошибок;
   `--self-test` — целостность бандла; `login` — живой вход.

## 5. Типовые ошибки

| Симптом | Причина и что делать |
| --- | --- |
| `LoginFailed error=8` | Блок лицензии не от этой сборки или `apkSize` не совпадает с APK, из которого взят блок. Перевырезать `client-license.bin` и выставить размер base APK. |
| `LoginFailed error=…` сразу на ClientHello | Несовпадение `appBinaryVersion`, `keyVersion` или `protocolVersion` с сервером. Сверить с fingerprint-пробой и `libg.so`. |
| Сервер молчит, таймаут после ClientHello | Устаревшие `packetIds` (сменился протокол) или неверный `cryptoMode`; проверить карту пакетов. |
| `Invalid installed Nulls APK license block` | Файл короче 58 байт либо длина хвоста по смещению 56 больше остатка файла. |
| `APK package does not match this client` | В `--apk` указан не тот APK (ожидается `daniillnull.nulls.brawlstars`). |
| `Update probe` вернул код, отличный от 7 | Сервер отверг пробу: скорее всего, установлен более новый APK, чем поддерживает клиент, или протокол ещё не разобран. |
| `installedOlder: true` | Установленный APK старее текущего конфига — обновление не применяется, это защита от отката. |
| `config.json changed during verification` | Конфиг правили во время проверки; повторить запуск. |

## NOTICE

Обновление работает с материалами игры (APK, `libg.so`, блок лицензии,
fingerprint), права на которые принадлежат правообладателям; MIT из `LICENSE`
их не покрывает. Проект неофициальный и не связан с Supercell и Nulls Brawl.