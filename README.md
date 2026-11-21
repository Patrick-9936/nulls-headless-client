# nulls headless client

[![ci](https://github.com/Patrick-9936/nulls-headless-client/actions/workflows/ci.yml/badge.svg)](https://github.com/Patrick-9936/nulls-headless-client/actions/workflows/ci.yml)
[![release](https://img.shields.io/github/v/release/Patrick-9936/nulls-headless-client)](https://github.com/Patrick-9936/nulls-headless-client/releases)
[![node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)](package.json)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Клиент протокола **Nulls Brawl 69.252** для Node.js: аккаунты, клубы, лобби, друзья,
наблюдение за боями и несколько онлайн-сессий одновременно. Без игры, без root, без
правки APK — только сеть и протокол.

Проект неофициальный и не связан с Supercell или Nulls. Код — MIT ([`LICENSE`](LICENSE)),
оговорки про игру, ассеты и дампы — [`NOTICE.md`](NOTICE.md).

Нужен только Node.js 20+: клиент запускается на **Windows, Linux, macOS и Android (Termux)**.
Что где работает и какие есть ограничения — [`docs/PLATFORMS.md`](docs/PLATFORMS.md).

## Что умеет

| Область | Возможности |
|---|---|
| Аккаунты | создание гостя, вход по сохранённому токену, регион, смена устройства, блокировка файла от двух сессий |
| Клубы | создание, вход, чат, лента, заявки, роли, кик, приглашения, настройки, топ, рекомендации |
| Лобби | создание комнаты и вход по коду, приглашения друга и соклубника, ответы, режим и карта, готовность |
| Друзья | добавление по тегу, принятие, отказ, удаление, список и онлайн |
| Бой | подбор, отмена, загрузка боя, UDP-кадры, Brawl TV и наблюдение за игроком |
| Флот | запуск десятков ботов, команды на лету, пауза и возобновление, статусы |
| Интерфейс | интерактивное меню, CLI, четыре языка (ru / en / tr / zh), JSON-вывод для скриптов |
| Связка | Nulls Connect: PIN на e-mail, bearer-токен, bind игрового аккаунта |

Что проверено на живом сервере, а что нет — [`docs/VERIFICATION.md`](docs/VERIFICATION.md) и
`node Program.js features`.

## Быстрый старт

### Одним файлом

Скачайте `Nulls.js` из [последнего релиза](https://github.com/Patrick-9936/nulls-headless-client/releases/latest)
и запустите:

```sh
node Nulls.js
```

Нужен Node.js 20+, зависимости уже внутри. Управление: стрелки, enter, esc, ctrl+c.
При первом запуске рядом появится `.nulls-single-<версия>` с настройками и аккаунтами —
не удаляйте её, в ней живут ваши сохранённые входы. Подробнее: [`docs/TUI.md`](docs/TUI.md).

### Из git

```sh
git clone https://github.com/Patrick-9936/nulls-headless-client.git
cd nulls-headless-client
npm ci --ignore-scripts
node TUI.js
```

### Из zip в Termux

Распаковывайте **в домашнюю папку**, не запускайте из общего хранилища Android —
там нет прав на создание файлов состояния:

```sh
pkg install nodejs unzip
unzip /sdcard/Download/nulls-headless-client-0.3.2.zip -d "$HOME"
cd ~/nulls-headless-client-0.3.4
node Program.js create-account --account accounts/bot-1.json --name 'МойБот' --once
node Program.js login --account accounts/bot-1.json
```

В zip зависимости и блок лицензии уже входят. Ник задаётся при регистрации, сменить его
потом нельзя.

## Аккаунты

`accounts/*.json` содержат `passToken` — это и есть вход. Сохраняйте файлы: удаление
аккаунта создаёт нового гостя, а не восстанавливает прежнего. Один файл аккаунта может
использовать только одна сессия; это защищает `lib/AccountLock.js` и файл `.lock`.

Архив релиза не содержит готовых аккаунтов — только код, зависимости и блок лицензии.

## Язык интерфейса

```sh
node Program.js lang           # текущий язык, режим и источник
node Program.js lang tr        # зафиксировать язык в config.json
node Program.js lang auto      # вернуть авто-выбор по системе
node Program.js help --lang en # разовый запуск на другом языке
```

Поддерживаются `ru`, `en`, `tr`, `zh`. По умолчанию включён авто-режим
(`uiLanguage: "auto"`): язык берётся из `NULLS_LANG` / `LC_ALL` / `LC_MESSAGES` / `LANG`,
затем из системной локали Node (`Intl`), иначе `ru`. Явный `--lang` важнее конфига,
конкретный код в `uiLanguage` важнее окружения.

Переключение языка интерфейса **не** меняет раскладку логина: `locale` уходит только в
legacy-логин, а `preferredLanguage` / `storefront*` — только в modern, и включать modern
вслепую небезопасно (issue #3). Как добавить свой язык — [`docs/I18N.md`](docs/I18N.md).

## Несколько ботов

```sh
node tools/fleet.js start --first 1 --count 3 --name-prefix 'МойБот' --concurrency 3
node tools/fleet.js status
node tools/fleet.js command --bot 1 --action create-club --club-name 'НашКлуб'
node tools/fleet.js command --bot 2 --action join-club --club-tag '#ТЕГ_ИЗ_ОТВЕТА'
node tools/fleet.js stop
```

`--first` и `--count` задают файлы `accounts/bot-N.json`, `--name-prefix` применяется
только к новым аккаунтам. Ошибка одного бота не замораживает очередь: отказ виден в
`clubError`, уже вошедший бот остаётся онлайн. Есть `retry`, `pause`, `resume`.

Фоновый процесс пишет `fleet.log` и `fleet-status.json`, переподключается после разрыва и
просит termux wake-lock (на Windows/Linux/macOS — no-op). Android всё равно может прибить
Termux — для постоянной работы нужен сервер, а не телефон. Наличие процесса не значит, что
все боты вошли: смотрите `states` и `bots`. `--timeout` — миллисекунды.

### Наблюдение и реестр

```sh
node Program.js watch                    # живой дашборд: статусы, метрики, хвост fleet.log
node Program.js watch --once --json      # один кадр в JSON
node tools/accounts.js list              # реестр accounts/index.json: теги, имена, клубы
node tools/accounts.js stats
node tools/accounts.js prune --dry-run   # что можно удалить, ничего не удаляя
```

`watch` читает `fleet-status.json`, `fleet.pid`, `fleet.log`, `accounts/index.json` и
`.runtime/results`; флаги `--interval`, `--log-lines`, `--bots 1:13`, `--no-color`:
[`docs/WATCH.md`](docs/WATCH.md). Реестр и `prune` (файлы с токенами не удаляются никогда):
[`docs/ACCOUNTS.md`](docs/ACCOUNTS.md).

`fleet-status.json` содержит `metrics`: uptime, входы, провалы, `avgLoginMs`, `p95LoginMs`,
`avgRttMs` (время «запрос→ответ», окно 50), счётчики команд. Статус пишется не чаще 2 раз в секунду (коалесирование событий);
`--status-interval 0` возвращает запись на каждое изменение. `fleet.log` ротируется
(5 МБ × 3 архива, `--log-max-bytes`, `--log-keep`), `.runtime` чистится от старых
результатов и зависших команд. Подробности — [`docs/FLEET.md`](docs/FLEET.md).

## Лобби и бой

Команды лобби и боя лучше отправлять через `fleet command`: так сохраняется одна
онлайн-сессия, а не открывается новая на каждую команду.

```sh
node tools/fleet.js command --bot 1 --action create-room --type 0
node tools/fleet.js command --bot 1 --action chat --text 'Привет'
node tools/fleet.js command --bot 1 --action matchmake
node tools/fleet.js command --bot 1 --action cancel-matchmake
node tools/fleet.js command --bot 1 --action leave-room
```

`--type 0` — обычная команда, `--type 1` — дружеский бой. В обычной команде сервер
запрещает одинаковых бойцов. Выбор бойца в лобби — `team-brawler --brawler <id> [--slot 0]`
(пакет 14375, экспериментальная: раскладка восстановлена из libg, живьём сервер её пока
не подтвердил — см. [`docs/REQUESTS.md`](docs/REQUESTS.md)). `--battle-transport udp`
включает получение кадров боя и нейтральные пакеты, движение и атаки не реализованы:
[`docs/BATTLE_UDP.md`](docs/BATTLE_UDP.md).

Прогресс подбора (`x/6`, `x/10`) приходит от сервера и виден в `matchmaking` статуса.
В `tools/candidates.js` следующий бот по умолчанию ждёт назначения матча предыдущему
(`--max-queued 1`): [`docs/MATCHMAKING.md`](docs/MATCHMAKING.md).

Полный список команд и параметров — [`docs/COMMANDS.md`](docs/COMMANDS.md); статусы
функций — `node Program.js features`.

Важное правило проекта: успешная отправка пакета не считается выполненным действием.
Если сервер не подтвердил, вы получите `confirmed: false`, отказ или таймаут. Заявки,
регионы и встроенные боты: [`docs/REQUESTS.md`](docs/REQUESTS.md). Непроверенные команды
помечены экспериментальными и требуют `--experimental`.

## Nulls Connect

Привязка игрового аккаунта к identity на `connect.nulls.gg`: PIN на e-mail, bearer-токен,
bind по JWT из `LoginOk`.

```sh
node tools/connect.js pin --email you@example.com
node tools/connect.js confirm --email you@example.com --pin 1234
node tools/connect.js bind --account accounts/bot-1.json     # привязать
node tools/connect.js links
node tools/connect.js unbind --account accounts/bot-1.json   # отвязать
node Program.js login --account accounts/bot-1.json --connect-bind  # привязать сразу при входе
```

Токен хранится в `.runtime/connect.json` с правами `0600` и не попадает в git.
`--connect-bind` необязателен: без bind-токена или bearer шаг пропускается, вход остаётся
успешным. Полный цикл, переменные окружения и таблица ошибок:
[`docs/CONNECT.md`](docs/CONNECT.md).

## Свои скрипты

Скрипты можно держать вне репозитория и копировать в `tools/`: они подключают модули
клиента относительными путями. Контракт совместимости — что гарантируется, а что может
измениться — [`docs/SCRIPTS.md`](docs/SCRIPTS.md).

```sh
cp /sdcard/nulls-tools/*.js ~/nulls-headless-client/tools/
cd ~/nulls-headless-client
node tools/club-rush.js help
```

В репозитории уже есть `tools/fleet.js` (флот), `tools/connect.js` (Nulls Connect),
`tools/candidates.js` (регистрация кандидатов с бюджетом памяти), `tools/proxy-watch.js`
(сбор рабочих прокси), `tools/test-session.js` (ограниченный интеграционный тест).

## Обновление под новый APK

```sh
node Program.js update --check
node Program.js update --account accounts/offline-bot.json
node Program.js update --watch --interval 1800 --account accounts/offline-bot.json
node Program.js update --rollback
```

Обновление читает установленный APK и серверный fingerprint, изменения применяются после
проверки `LoginOk` и `Home`. Нужен существующий **отключённый** аккаунт: блокировка не
даст двум сессиям войти одновременно. Для APK есть `--apk PATH`, `--split-apk PATH`, для
ресурсов — `--no-apk`; извлечение требует python и aapt2. Скрипт не скачивает игру.
Смена криптографии в следующем major может потребовать правок кода — совместимость с v70
не гарантируется.

Как обновить `config.json` и блок лицензии вручную: [`docs/APK-UPDATE.md`](docs/APK-UPDATE.md).

## Прокси

```sh
node Program.js login --account accounts/bot-1.json --proxy-file proxy.json
node tools/proxy-watch.js --pool-limit 500
```

`proxy.json`: `{"url":"socks5://HOST:PORT"}` или
`{"url":"http://HOST:PORT","username":"USER","password":"PASS"}`. Есть
`--proxy-pool-file working-proxies.json` и сборщик `tools/proxy-watch.js`. Рабочим
считается туннель, получивший корректный `ServerHello` от сервера игры. Трафик устройства
не перенаправляется.

## Диагностика

```sh
node Program.js help
node Program.js info
node Program.js features
node Program.js room-code X5AMWKM
node Program.js tag-decode '#GL0J2CPP0'
node Program.js account-info --account accounts/bot-1.json
```

`--dump` сохраняет пакеты в `PacketsDumps/`, включая данные входа: не публикуйте дампы и
токены. Код комнаты раскрывает её ID, но не прошлые и будущие комнаты:
[`docs/ROOM_CODES.md`](docs/ROOM_CODES.md). Возраст в Nulls не подтверждается, `--age`
отклоняется. Supercell ID не реализован, дружба работает по игровому тегу.

Brawl TV: `brawl-tv`, `brawl-tv-channels`, `brawl-tv-next` — [`docs/BRAWL_TV.md`](docs/BRAWL_TV.md).
Ограниченный тест в Codespaces — [`docs/CODESPACES.md`](docs/CODESPACES.md).

## Разработка

```sh
npm ci --ignore-scripts
npm test            # node --test, весь набор
npm run check       # синтаксис + info
npm run lint        # то же, для CI
node Nulls.js --self-test
```

Один тест: `node --test tests/<файл>.test.js`. Стиль — prettier и editorconfig в корне,
правила — `eslint.config.mjs`. Как устроен репозиторий и как добавить команду или пакет:
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Как контрибьютить:
[`CONTRIBUTING.md`](CONTRIBUTING.md).

## Сборка релиза

```sh
npm run bundle        # zip + Nulls.js + sha256
npm run bundle:check  # пересобрать в $TMPDIR и сверить с закоммиченным Nulls.js
```

Сборка воспроизводима: `node_modules/.package-lock.json`, npm-кэши и `node_modules/.bin`
в бандл не попадают, отметки времени в zip фиксированы, поэтому архив собирается
байт-в-байт. Содержимое `Nulls.js` CI сверяет по хешу (а не по байтам файла: сам gzip
зависит от версии zlib в системе). Расхождение — красный CI. `Nulls.js` в корне —
готовая сборка, шаблон запуска — `tools/single-file.template`. Тег `vX.Y.Z` запускает
релизный workflow; пошагово — [`docs/RELEASING.md`](docs/RELEASING.md).

## Документация

| Файл | О чём |
|---|---|
| [`docs/COMMANDS.md`](docs/COMMANDS.md) | все команды, флаги, примеры |
| [`docs/REQUESTS.md`](docs/REQUESTS.md) | приглашения, заявки, регионы, встроенные боты |
| [`docs/MATCHMAKING.md`](docs/MATCHMAKING.md) | подбор, очереди, неизвестный исход |
| [`docs/BATTLE_UDP.md`](docs/BATTLE_UDP.md) | кадры боя по UDP |
| [`docs/BRAWL_TV.md`](docs/BRAWL_TV.md) | наблюдение и каналы |
| [`docs/ROOM_CODES.md`](docs/ROOM_CODES.md) | коды комнат |
| [`docs/TUI.md`](docs/TUI.md) | меню, навигация, формы |
| [`docs/I18N.md`](docs/I18N.md) | языки интерфейса и как добавить свой |
| [`docs/CONNECT.md`](docs/CONNECT.md) | Nulls Connect |
| [`docs/SCRIPTS.md`](docs/SCRIPTS.md) | контракт для внешних скриптов |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | устройство проекта |
| [`docs/VERIFICATION.md`](docs/VERIFICATION.md) | что проверено на живом сервере |
| [`docs/APK-UPDATE.md`](docs/APK-UPDATE.md) | обновление под новый APK |
| [`docs/RELEASING.md`](docs/RELEASING.md) | выпуск версии |
| [`docs/CODESPACES.md`](docs/CODESPACES.md) | ограниченный интеграционный тест |
| [`docs/FLEET.md`](docs/FLEET.md) | флот: статус, команды, лимиты |
| [`docs/WATCH.md`](docs/WATCH.md) | дашборд `watch`, `--json` / `--quiet` |
| [`docs/ACCOUNTS.md`](docs/ACCOUNTS.md) | реестр аккаунтов, `prune`, токены |
| [`docs/ERRORS.md`](docs/ERRORS.md) | коды ошибок для скриптов |
| [`docs/PLATFORMS.md`](docs/PLATFORMS.md) | Windows, Linux, macOS, Android |

## Ограничения

- Игра не запускается: клиент говорит по протоколу, но не рендерит и не играет.
- Управление бойцом, движение и атаки не реализованы.
- Серверные рекомендации клубов и ранжирование — на стороне сервера.
- `Supercell ID`, подтверждение возраста, смена уже заданного ника — не поддерживаются.
- Долгая работа ботов на телефоне упирается в ограничения Android, а не в клиент.

## Лицензия

Код репозитория — MIT ([`LICENSE`](LICENSE)). Права на игру, её ассеты и данные APK
принадлежат правообладателям; `client-license.bin` под MIT не попадает. Проект
неофициальный.