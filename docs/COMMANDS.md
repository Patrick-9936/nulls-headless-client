# Команды

Основная форма: `node Program.js COMMAND --account accounts/bot-1.json OPTIONS`.
Для работающего бота: `node tools/fleet.js command --bot 1 --action COMMAND OPTIONS`.
`--all` выполняет команду на каждом боте последовательно. Параметры с пробелами и теги с `#` заключайте в кавычки. `--timeout 10000` — 10 секунд. `--dry-run` показывает формирование пакета без подключения.

## Аккаунт и друзья

| Команда | Параметры / результат |
|---|---|
| create-account | `--name 'Бот' --account accounts/new.json --once`; отдельный новый файл |
| login | повторный вход, без `--once` удерживает сессию |
| account-region | `--region US` / `KZ` / `14:N`; подтверждение 24178/0 и той же страны |
| account-info | публичный тег, имя, сохранённый клуб без токена |
| friend | `--tag '#TAG'`; отправить заявку по игровому тегу |
| accept-friend | `--tag '#TAG'`; проверяет relationship=4 |
| decline-friend | `--tag '#TAG'`; отклонить заявку, проверяет отсутствие в списке |
| remove-friend | `--tag '#TAG'`; удалить друга |
| friends | полный серверный список |
| friends-online | только явно подтверждённые онлайн, неизвестные учитываются отдельно |
| top | рейтинг игроков: `--type 0 [--local] [--brawler 16:0]`; теги, места, очки |
| spectate | `--tag '#TAG'`; цель должна быть в бою, оставляет подключение открытым |
| stop-spectate | остановка наблюдения и повторный вход с подтверждением Home |
| brawl-tv | `--experimental`; первый канал, `--channel ID` или `--tag '#TAG'`; TV-флаг и загрузка |
| brawl-tv-channels | `--experimental`; список каналов, ответ 24700 |
| brawl-tv-next | `--experimental --channel ID`; следующая трансляция, ответ 24701 |

Подробности Brawl TV: [BRAWL_TV.md](BRAWL_TV.md). Для `spectate` есть флаг `--brawl-tv`; старое имя `--after-death` сохранено для совместимости.

## Клуб

| Команда | Параметры |
|---|---|
| create-club | `--club-name 'Название'` |
| join-club | `--club-tag '#TAG'` |
| leave-club | без параметров |
| club-info | `--club-tag '#TAG'` или текущий клуб |
| club-members | список участников, теги, роли |
| club-online | участники и полученные данные присутствия; данные могут отсутствовать |
| club-chat | `--text 'Привет'`; проверяет эхо серверного сообщения |
| club-stream | разобранная серверная лента текущей сессии; `--refresh` для переподключения |
| club-requests | ожидающие заявки с текстом и ID записи |
| club-request | `--club-tag "#TAG" --text "Заявка"`; текст обязателен |
| club-answer | `--tag "#TAG" --accept=true\|false` или `--entry-id hi:lo` |
| club-description | `--description 'Текст'` |
| club-trophies | `--required-trophies 10000`; произвольные значения сервер может нормализовать |
| club-settings | `--description TEXT --type 1 --required-trophies 0 --family-friendly false`; type: 1 открытый, 2 по приглашению, 3 закрытый |
| club-promote / club-demote | `--tag '#TAG'`; порядок member → senior → vice → president |
| club-role | `--tag '#TAG' --role member|senior|vice|president`; президентство требует явного выбора |
| club-kick | `--tag '#TAG' [--text 'Причина']` |

Изменения требуют полномочий аккаунта. Настройки сначала читаются, остальные поля сохраняются. Порог 0 и 10000 проверен; 200 сервер не применил. `--badge 8:N` и `--region 14:N` проверяются по свежему ответу сервера; каталоги: `club-badges` и `regions`. При изменении других полей прочитанная страна клуба сохраняется.

## Лобби, карта и подбор

| Команда | Параметры |
|---|---|
| create-room | `--type 0` обычная команда или `--type 1` дружеская |
| join-room | `--code X...` |
| leave-room | выйти из лобби |
| team-info | последнее состояние этой онлайн-сессии, участники/бойцы/карта/код |
| chat | `--text 'Привет'` в лобби |
| team-kick | `--tag '#TAG'`; проверяет отсутствие участника |
| team-map | `--map 'ИмяИзКаталога'` или `--location 15:N` |
| team-mode | `--mode BrawlBall`; выбирает карту этого режима из каталога |
| team-location | `--location 15:N [--modifiers 1,2]` |
| modes | `--mode BrawlBall`; каталог 468 карт из APK, доступность зависит от сервера |
| ready / unready | состояние готовности своего участника |
| matchmake | обычный подбор: `stage: queued` после 20405, `loading` после пакетов загрузки |
| cancel-matchmake | отменить активный подбор; подтверждение 20406 |
| team-brawler | пока недоступна; неверный пакет выбора отключал соединение, отправка заблокирована |

В обычной команде одинаковые бойцы запрещены. Карты каталога могут отсутствовать в текущей ротации. Дружеский старт проверен двумя ботами, обычная очередь и отмена одним. Бот не управляет персонажем в самом матче.

## Приглашения в лобби

`team-invite --tag '#TAG'` проверяет принятую дружбу либо членство в вашем клубе и ждёт появления приглашения в серверном состоянии. Игрок должен быть онлайн и принимать приглашения.

`accept-invite [--tag '#ОТПРАВИТЕЛЬ'] [--code X...] [--spectator]` принимает последнее подходящее входящее приглашение. `decline-invite` с теми же параметрами отклоняет его. `invite-answer --accept=true|false` — общая форма. Если входящего пакета в сессии нет, укажите `--code`. Решение кодируется 1/2, передаётся ID комнаты. Для подтверждения отказа владелец должен быть другим ботом того же fleet; иначе результат отправки не выдаётся за подтверждение сервером.

## Заявки, события, статусы и боты

Рабочие команды: `team-request --code X... --tag "#ВЛАДЕЛЕЦ"`, `team-cancel-request`, `team-request-answer --tag "#ИГРОК" --accept=true|false`, `team-cancel-invite --tag "#ИГРОК"`, `team-event --event ID --slot N --modifier 0`, `team-status --status N`, `team-bot --slot N --disabled=true|false`. Подробные условия и сценарии: [REQUESTS.md](REQUESTS.md).

`invitations` показывает полученные приглашения текущей сессии.

## Экспериментальные действия

Требуют `--experimental`: `club-invite --tag "#TAG"`, `team-advertise --type N`, `practice`, `player-status --status N --extra N`, старый `team-answer --response N --extra N`. Для первых четырёх отправка проверена, требуемый результат пока не получен. Они не объявлены работающими. `player-status` проверяет ответ у онлайн-друга того же fleet. Используйте `team-status` для статуса участника лобби и `accept-invite`/`decline-invite` для приглашений.

## Локальные утилиты

`features` — статусы функций; `info` — версия и сервер; `tag-decode '#TAG'` — ID тега; `tag-encode --high 0 --low 48610317` — тег ID; `room-code --code X5AMWKM` — ID комнаты; `room-code --high 0 --low 2939074` — код. Эти утилиты не проверяют существование объектов.

Fleet: `start`, `run` (на переднем плане), `status`, `stop`, `command`, `retry`, `pause`, `resume`. `--count 3 --first 1 --name-prefix Bot --concurrency 3 --club-tag '#TAG'`. Ограничение count 1–100, concurrency 1–20. Для сохранённых аккаунтов не удаляйте accounts JSON. Отдельный процесс с тем же аккаунтом блокируется.

## Рекомендованные клубы

```sh
node Program.js club-recommendations --account accounts/bot-1.json --once
```

Возвращает clubs: тег, название, эмблему, регион, тип, число участников, трофеи и порог входа. Запрос 14303 version 9 с VInt(0), ответ 24304. Порядок списка задаёт сервер; пустой список допустим. Наличие клуба в списке не подтверждает возможность вступления: используйте join-club отдельно. Проверка выполняется по новому ответу сервера.

Проверено 9 октября: получены 50 рекомендаций. Если регион равен null, сервер его не указал.
