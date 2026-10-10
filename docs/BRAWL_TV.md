# Brawl TV

Поддержаны список каналов, запрос следующей трансляции и наблюдение в TV-режиме. На обычный запрос 14104 добавляется TV-флаг `true`; обычное наблюдение использует `false`. Это подтверждено native-вызовами Nulls v69.252. Frida, root и установленная игра для этих команд не нужны.

```sh
# Список каналов от сервера
node Program.js brawl-tv-channels --account accounts/bot-1.json --experimental --once

# Следующая трансляция канала; ID берётся из списка, а не подбирается
node Program.js brawl-tv-next --channel 0 --account accounts/bot-1.json --experimental --once

# Открыть первый доступный канал
node Program.js brawl-tv --account accounts/bot-1.json --experimental --battle-transport udp

# Открыть выбранный канал
node Program.js brawl-tv --channel 0 --account accounts/bot-1.json --experimental --battle-transport udp

# TV-режим наблюдения по тегу, как в Brawl-Spectator
node Program.js brawl-tv --tag '#8R88G82L28' --account accounts/bot-1.json --experimental --battle-transport udp

# Флаг для обычной команды spectate
node Program.js spectate --tag '#8R88G82L28' --brawl-tv --account accounts/bot-1.json --battle-transport udp

# Для уже работающей сессии fleet
node tools/fleet.js command --bot 1 --action brawl-tv --tag '#8R88G82L28' --experimental
node tools/fleet.js command --bot 1 --action stop-spectate
```

Нужен существующий аккаунт или новый файл с `--name`. Для TCP-прокси добавьте `--proxy-pool-file PATH`; для UDP требуется SOCKS5 UDP ASSOCIATE. Прямое подключение используется по умолчанию.

`brawl-tv` с тегом отправляет один запрос 14104, version 9, LogicLong + true. Без тега клиент получает каналы (14700→24700), выбирает первый либо `--channel`, запрашивает следующую трансляцию (14701→24701), затем открывает указанного сервером игрока. Оба запроса каналов имеют version 33. Никаких массовых зрителей или фоновых циклов эти команды не запускают.

Пустой канал и ID 0:0/-1:-1 не считаются доступной трансляцией. Ответ следующего канала с другим ID игнорируется. Ответ внешнего видеопотока возвращает `stage: external-stream`, `confirmed: false`: видеоплеер в headless-клиенте отсутствует, ссылки автоматически не открываются. Второе числовое поле 24701 сохранено как `marker`; его точная семантика не установлена.

`stage: loading` подтверждает только непустой ответ 20559/24112. Для подтверждения поступления кадров используйте UDP; получение загрузки не доказывает видимость зрителя в игровом интерфейсе. Повторный выбор каналов после матча не автоматизирован. Сервер может не поддерживать список TV-каналов или отклонить запрос по тегу; команды остаются экспериментальными до проверки реальных ответов.

Старый `spectate --after-death` сохранён как совместимый псевдоним того же флага. Название было неточным: это TV-режим, поведение после смерти этим параметром отдельно не подтверждено. Явный `--brawl-tv=false` имеет приоритет над старым параметром.

Источники: [Brawl-Spectator](https://github.com/byRyo/Brawl-Spectator), [StartSpectateMessage](https://github.com/byRyo/Brawl-Spectator/blob/main/src/packets/client/StartSpectateMessage.js); автор указывает старую версию игры. В Nulls использованы собственные адреса, а не устаревшие offsets проекта. Native-подтверждения: `docs/native/brawl-tv-flag.txt`, `14700-encode.txt`, `14701-encode.txt`, `24700-encode-decode.txt`, `24701-encode-decode.txt` и `docs/protocol-evidence.json`.
