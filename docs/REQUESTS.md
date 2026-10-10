# Заявки, регион и встроенные боты

Проверено на настоящем сервере Nulls 69.252 8 октября 2026. Команды для работающих ботов отправляйте через fleet. Теги заменяйте своими; новые аккаунты создаются автоматически при старте fleet с `--name-prefix`.

## Клуб по заявкам

Бот 1 должен быть президентом/иметь право принимать участников. Бот 2 должен находиться вне клуба.

```sh
node tools/fleet.js command --bot 1 --action club-settings --type 2
node tools/fleet.js command --bot 2 --action club-request --club-tag '#КЛУБ' --text 'Хочу вступить'
node tools/fleet.js command --bot 1 --action club-requests
node tools/fleet.js command --bot 1 --action club-answer --tag '#БОТ2' --accept=false
```

Для одобрения другой ожидающей заявки используйте `--accept=true`. Можно ответить через `--entry-id 0:ID_ЗАПИСИ`. Клиент сам находит ID записи по тегу; отправлять тег игрока вместо ID заявки было ошибкой и исправлено. Текст обязателен. Состояния записи: 1 ожидает, 2 одобрена, 3 отклонена. При одобрении дополнительно проверяется свежий состав клуба.

Отправка подтверждается ответом 24333 с кодом 50. Если владелец — другой онлайн-бот этого fleet, клиент также проверяет текст в его ленте (`textVerified: true`). Код 52 означает уже существующую заявку; клиент не выдаёт новый текст за применённый. `club-stream` читает серверную ленту текущей сессии, `--refresh` переподключается для получения свежей истории. Разобраны типы записей 2/3/4/6/8; неизвестный тип даёт ошибку, не пустой успешный список.

## Заявки и приглашения в лобби

```sh
node tools/fleet.js command --bot 1 --action create-room --type 0
node tools/fleet.js command --bot 2 --action team-request --code XКОД --tag '#БОТ1'
node tools/fleet.js command --bot 1 --action team-info
node tools/fleet.js command --bot 2 --action team-cancel-request
```

Чтобы ответить, сначала отправьте новую заявку:

```sh
node tools/fleet.js command --bot 1 --action team-request-answer --tag '#БОТ2' --accept=true
```

`--accept=false` отклоняет заявку. В `team-info` есть `requests`, `pendingInvites`, участники и их `status`. Порядок ID исправлен: сначала владелец, затем команда. Появление и отмена заявки подтверждаются на стороне владельца. Для `confirmed: true` при отправке/отмене нужен владелец в том же fleet; внешнему владельцу пакет отправляется с `confirmed: false` и пояснением.

```sh
node tools/fleet.js command --bot 1 --action team-invite --tag '#ДРУГ_ИЛИ_СОКЛУБНИК'
node tools/fleet.js command --bot 2 --action accept-invite
node tools/fleet.js command --bot 2 --action leave-room
```

Проверено приглашение соклубника без дружбы. Для отмены ещё не принятого приглашения отправитель использует `team-cancel-invite --tag '#TAG'`. Для отказа получатель использует `decline-invite`. Внутри одного fleet клиент дожидается доставки приглашения получателю, чтобы следующая команда принятия не выполнялась раньше входящего пакета. Сервер может отказать: например, код 25 для заполненной команды, 27 для игрока, который не принимает приглашения.

## Регион и эмблема

```sh
node Program.js regions
node Program.js club-badges
node tools/fleet.js command --bot 1 --action account-region --region US
node tools/fleet.js command --bot 1 --action club-settings --region 14:125 --badge 8:1
```

`account-region` принимает код страны (`US`, `KZ`), индекс или `14:N`; ждёт 24178, код 0 и ту же ссылку класса 14. Проверены US (14:249) и KZ (14:125). Это выбор страны профиля, не прокси и не смена сетевого сервера. Эмблема клуба проверяется по свежему ответу 24301, страна клуба — по ссылке или возвращённому коду страны. Изменение описания не сбрасывает прочитанную страну клуба.

## Событие, статус и встроенные боты

```sh
node tools/fleet.js command --bot 1 --action team-status --status 2
node tools/fleet.js command --bot 1 --action create-room --type 1
node tools/fleet.js command --bot 1 --action team-bot --slot 1 --disabled=true
node tools/fleet.js command --bot 1 --action team-bot --slot 1 --disabled=false
```

Статус подтверждается в поле своего участника. Номера статусов не снабжены непроверенными названиями. Встроенные боты доступны в дружеском лобби; выключенный слот появляется в `disabledSlots`, включённый исчезает.

`team-event --event ID --slot N --modifier 0` выбирает серверное событие в обычной команде. Проверена смена 10248817/1 → 20248817/2 с изменением карты и вместимости. Эти ID относятся к ротации дня проверки: не используйте их как постоянный каталог. ID события отличается от индекса карты; полный каталог событий Home ещё не разобран.

## Пока экспериментально

`club-invite`, `team-advertise`, `practice`, `player-status`, старый `team-answer` требуют `--experimental`. Первые четыре проверены отправкой, но нужного серверного результата не получено. `player-status` проверяет присутствие через онлайн-друга того же fleet; это отдельная команда от работающей `team-status`. Реклама команды и тренировочный бой не объявлены работающими. Для старого `team-answer` используйте проверенные `accept-invite`/`decline-invite`.
