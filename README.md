# nulls headless client 0.2.6

клиент протокола nulls brawl v69.252: аккаунты, клубы, лобби, друзья, наблюдение и несколько онлайн-сессий. результаты проверок 8–9 октября 2026: [docs/VERIFICATION.md](docs/VERIFICATION.md).

## один файл с меню

скачайте `Nulls.js` из [релиза 0.2.6](https://github.com/Patrick-9936/nulls-headless-client/releases/tag/v0.2.6) и запустите:

```sh
node Nulls.js
```

нужен Node.js 20+. зависимости встроены. управление: стрелки, enter, esc; ctrl+c завершает сессии меню. при первом запуске рядом появится `.nulls-single-0.2.6` с настройками и аккаунтами. сохраняйте эту папку для повторного входа. подробнее: [docs/TUI.md](docs/TUI.md).

для запуска из git:

```sh
git clone https://github.com/Patrick-9936/nulls-headless-client.git
cd nulls-headless-client
npm ci --ignore-scripts
node TUI.js
```

## установка и первый запуск

в termux установите Node.js и распакуйте архив **в домашнюю папку**, не запускайте проект из общего хранилища android:

```sh
pkg install nodejs unzip
unzip /sdcard/Download/nulls-headless-client-0.2.6.zip -d "$HOME"
cd ~/nulls-headless-client-0.2.6
node Program.js create-account --account accounts/bot-1.json --name 'МойБот' --once
node Program.js login --account accounts/bot-1.json
```

в zip-релизе зависимости включены. нужен Node.js 20+. игра, root и изменение apk для обычного запуска не нужны; конфигурация и блок лицензии включены. на linux получайте обновления из актуального apk вручную. ник задаётся при регистрации; смена уже заданного ника недоступна.

`accounts/*.json` содержат токены: сохраняйте их для повторного входа. архив не содержит готовых аккаунтов. удаление аккаунтов создаст новых гостей, а не восстановит прежних. один файл аккаунта может использовать только одна сессия.

## несколько ботов

```sh
node tools/fleet.js start --first 1 --count 3 --name-prefix 'МойБот' --concurrency 3
node tools/fleet.js status
node tools/fleet.js command --bot 1 --action create-club --club-name 'НашКлуб'
node tools/fleet.js command --bot 2 --action join-club --club-tag '#ТЕГ_ИЗ_ОТВЕТА'
node tools/fleet.js stop
```

для подключения всех к существующему клубу добавьте к `start` `--club-tag '#TAG'`. `--name-prefix` используется для новых аккаунтов; существующие имена сохраняются. `--first` и `--count` определяют файлы `accounts/bot-N.json`. ошибка одного бота больше не замораживает всю очередь. отказ во вступлении виден в `clubError`, уже вошедший бот остаётся онлайн. повтор проблемных подключений: `node tools/fleet.js retry`. есть `pause` и `resume`.

`--timeout` в командах измеряется в миллисекундах. фоновый процесс пишет `fleet.log` и `fleet-status.json`, переподключается после разрыва и запрашивает termux wake-lock. android всё равно может завершить termux; для постоянной работы нужен работающий сервер. наличие процесса не означает успешный вход каждого бота: проверяйте `states` и `bots`.

## управление

команды лобби и боя лучше отправлять через `fleet command`: так сохраняется одна онлайн-сессия. `--once` после действия отключает отдельный клиент; последовательность таких процессов не заменяет постоянную сессию.

```sh
node tools/fleet.js command --bot 1 --action create-room --type 0
node tools/fleet.js command --bot 1 --action chat --text 'Привет'
node tools/fleet.js command --bot 1 --action matchmake
node tools/fleet.js command --bot 1 --action cancel-matchmake
node tools/fleet.js command --bot 1 --action leave-room
```

`create-room --type 0` создаёт обычную команду, `--type 1` — дружеский бой. обычный подбор и его отмена проверены одним ботом. в обычной команде сервер запрещает одинаковых бойцов; смена бойца пока не реализована надёжно. `--battle-transport udp` включает получение кадров боя и нейтральные пакеты. движение и атаки пока не реализованы: [инструкция udp](docs/BATTLE_UDP.md).

прогресс подбора `x/6`, `x/10` берётся из ответа сервера и виден в `matchmaking` статуса. в `tools/candidates.js` следующий бот по умолчанию ждёт назначения матча предыдущему (`--max-queued 1`). подробности и ограничения: [docs/MATCHMAKING.md](docs/MATCHMAKING.md).

все команды, параметры и примеры: [docs/COMMANDS.md](docs/COMMANDS.md). список статусов: `node Program.js features`. приглашения друга и соклубника, принятие, отказ и отмена проверены. заявки, регионы и встроенные боты: [docs/REQUESTS.md](docs/REQUESTS.md). для отклонения с подтверждением владелец лобби должен быть ботом того же fleet. непроверенные команды помечены экспериментальными и требуют `--experimental`. успешная отправка пакета не считается выполненным действием: `confirmed: false`, отказ или таймаут означают отсутствие подтверждения.

## обновление

```sh
node Program.js update --check
node Program.js update --account accounts/offline-bot.json
node Program.js update --watch --interval 1800 --account accounts/offline-bot.json
node Program.js update --rollback
```

при обновлении читаются установленный apk и серверный fingerprint; изменения применяются после проверки loginok и home. выберите существующий аккаунт, который сейчас отключён: блокировка защищает его от двух одновременных входов. для apk-файла есть `--apk PATH`, `--split-apk PATH`; для обновления только ресурсов — `--no-apk`. извлечение apk требует python и aapt2. скрипт не скачивает игру. изменение криптографии или формата протокола в следующем major может потребовать изменения кода; автоматическая совместимость с v70 не гарантируется.

## прокси и диагностика

`--proxy-file proxy.json` применяется к соединению клиента или fleet; формат: `{"url":"socks5://HOST:PORT"}` или `{"url":"http://HOST:PORT","username":"USER","password":"PASS"}`. есть `--proxy-pool-file working-proxies.json` и отдельный `tools/proxy-watch.js`; общий трафик устройства не перенаправляется. текущая проверка функций выполнялась напрямую.

```sh
node Program.js help
node Program.js info
node Program.js room-code X5AMWKM
node Program.js tag-decode '#GL0J2CPP0'
npm test
npm run check
```

код комнаты раскрывает её id, но не прошлые и будущие комнаты: [docs/ROOM_CODES.md](docs/ROOM_CODES.md). возраст в nulls не подтверждён, `--age` отклоняется. supercell id не реализован; дружба проверена по игровому тегу. `--dump` сохраняет пакеты для диагностики, включая данные входа: не публикуйте дампы и токены.

ограниченный тест менеджера ботов и двух процессов в codespaces: [инструкция](docs/CODESPACES.md).

brawl tv: команды brawl-tv, brawl-tv-channels, brawl-tv-next. инструкция: [docs/BRAWL_TV.md](docs/BRAWL_TV.md).

рекомендованные клубы: `node Program.js club-recommendations --account accounts/bot-1.json --once`. команда получает список от сервера; см. docs/COMMANDS.md.

## сборка выпуска

```sh
npm ci --ignore-scripts
npm test
npm run check
python tools/package_release.py
```

сборка создаёт zip, `Nulls.js` и файлы sha-256 в родительской папке проекта. `Nulls.js` в корне репозитория — готовая сборка; шаблон запуска находится в `tools/single-file.template`.
