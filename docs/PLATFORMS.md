# Платформы

Клиент — обычный Node.js (>= 20) без нативных зависимостей, поэтому ядро протокола одинаково
работает на Windows, Linux, macOS и Android (Termux). Различия собраны в `utils/Platform.js`.

## Матрица возможностей

| Возможность | Windows | Linux | macOS | Android (Termux) |
| --- | --- | --- | --- | --- |
| Клиент, аккаунты, клубы, бои | да | да | да | да |
| TUI (`node Program.js tui`) | да (Windows Terminal) | да | да | да |
| Флот (`tools/fleet.js`) | да | да | да | да |
| Wake-lock на время флота | нет (no-op) | нет (no-op) | нет (no-op) | `termux-wake-lock` |
| Обновление из установленного APK (`/system/bin/pm`) | нет | нет | нет | да |
| Обновление из файлов `--apk`/`--split-apk` | да | да | да | да |
| Права файлов `0600` | no-op | `chmod` | `chmod` | `chmod` |
| Определение «процесс флота жив» через `/proc` | нет | да | нет | да |

Python нужен только для обновления из APK (`tools/extract_update_apk.py`), для остального — нет.

## `utils/Platform.js`

| Функция | Поведение |
| --- | --- |
| `isAndroid()` | `process.platform === 'android'`, `PREFIX` содержит `com.termux`, либо существует `/system/bin/pm` |
| `isWindows()` / `isMac()` | `process.platform` — `win32` / `darwin` |
| `isLinux()` | `linux` или `android` (Termux считается Linux) |
| `pythonCommand()` | ищет рабочую команду: на Windows `python`, затем `python3`; на остальных `python3`, затем `python`. Проверка — `--version` с таймаутом 3 с, результат кэшируется. Нет Python — `null` |
| `wakeLock(on)` | только Android: `termux-wake-lock`/`termux-wake-unlock`; иначе `false` без запуска процессов |
| `supportsApkUpdate(options)` | `true`, если передан `apk`/`splitAPK`; иначе только Android с `/system/bin/pm` |
| `fileModeSecure(file)` | POSIX: `chmod 0600` в try/catch; Windows: no-op, `false` без исключения |

Модуль не выполняет работу при `require`: процессы запускаются только при вызове функций.

## Обновление из APK

`node tools/update.js` (или `npm run update`) на Android без аргументов читает установленный пакет
через `/system/bin/pm path <pkg>` и запускает `extract_update_apk.py`. На других платформах
`readAPK` возвращает `null`, и обновление проверяет только серверный fingerprint.

Обновление из файлов работает везде, где есть Python:

```sh
node tools/update.js --apk base.apk --split-apk split_config.arm64_v8a.apk --check
```

Если Python не найден, выводится: `нужен python3: обновление из APK требует python (python3 на
Linux/macOS)`. На Windows подойдёт `python` из python.org или `python3` из Store; проверка:
`python --version`.

`--watch` завершается по `Ctrl+C` (SIGINT). На Windows дополнительно обрабатывается `SIGBREAK`
(`Ctrl+Break`); `SIGTERM` в Windows редок, штатное завершение — `Ctrl+C`.

## Пути и переменные окружения

- Корень проекта — `path.resolve(__dirname, '..')`; все пути собираются через `path.join`, поэтому
  разделители платформ не важны.
- Рабочие каталоги: `.runtime/commands`, `.runtime/results`, `.runtime/candidates`, `.updates`,
  `accounts/`, `config.json`, `fleet-status.json`, `fleet.pid`, `fleet.log`.
- Временные файлы создаются рядом с целевыми (`<file>.tmp-<pid>`, `<file>.update-<pid>`) и
  переименовываются атомарно; системный `/tmp` не используется.
- `PREFIX` — признак Termux (`/data/data/com.termux/files/usr`).
- `node --test` и `os.tmpdir()` дают корректный временный каталог на всех платформах.

## Windows

PowerShell, из корня проекта:

```powershell
node Program.js info
node Program.js tui --account accounts/bot-1.json
node tools/fleet.js start --count 3 --first 1
node tools/fleet.js status
node tools/fleet.js command --all --action friends
node tools/fleet.js stop
```

- Теги и строки с `#` заключайте в одинарные кавычки: `--club-tag '#TAG'`.
- `fleet start` запускает отдельный процесс через `spawn(..., { detached: true })`; `fleet stop`
  вызывает `process.kill(pid, 'SIGTERM')`, Node завершает процесс.
- `fleet.pid` защищён от чужого PID проверкой `/proc/<pid>/cmdline`, но `/proc` на Windows нет,
  поэтому проверка пропускается. Если `status` показывает `running: true` при отсутствии флота,
  удалите `fleet.pid` вручную.
- Права `0600` на Windows не выставляются (NTFS ACL), это ожидаемо и не ошибка. Секреты
  (`config.json`, аккаунты, `client-license.bin`) храните в отдельном каталоге с ограниченным
  доступом.
- Долгие пути: включайте `LongPathsEnabled`, если проект лежит глубоко.

## Linux и macOS

```sh
node Program.js tui --account accounts/bot-1.json
node tools/fleet.js start --count 5 --concurrency 5
node tools/fleet.js status
node tools/fleet.js stop
```

macOS: wake-lock и `/system/bin/pm` отсутствуют, всё остальное идентично Linux. Файлы получают
`0600`. Для фона используйте `nohup`/`tmux` или `fleet start` (он сам отвязывается от терминала).

## Android (Termux)

```sh
pkg install nodejs python
node Program.js info
node tools/fleet.js start --count 3
node tools/fleet.js status
```

- `fleet run` берёт `termux-wake-lock` и отпускает его при остановке, чтобы Android не усыпил
  процесс; для работы команды нужен пакет `termux-api` или встроенная поддержка Termux.
- Проверка PID использует `/proc/<pid>/cmdline` — на Android он есть.
- Обновление из APK: нужен установленный пакет (`pm path`) и Python; либо `--apk`/`--split-apk`.
- Ограничения фона (Doze, агрессивные OEM-прошивки) могут убить процесс; статус покажет устаревший
  `updatedAt` и `running: false`.

## TUI и терминал

TUI требует TTY: Windows Terminal, PowerShell 7, консоль Linux/macOS и Termux подходят; перенаправление
вывода в файл или CI — нет. На Windows запускайте из Windows Terminal, а не из устаревшей консоли.

## Права файлов

`Store.write` создаёт файлы с режимом `0600` (на POSIX), `Platform.fileModeSecure` дополнительно
выставляет `0600` для `fleet.pid` и подобных файлов. На Windows режим игнорируется, функция
возвращает `false` и не бросает исключение. Каталоги `.runtime` и `.updates` создаются с
`recursive: true`.

## Проверка после установки

```sh
node --check lib/Fleet.js
node -e "const P=require('./utils/Platform');console.log(P.isAndroid(), P.pythonCommand(), P.supportsApkUpdate())"
node tools/fleet.js status
npm test
```

Ожидаемо: `status` печатает JSON с `running`, тесты проходят, `pythonCommand()` возвращает имя
команды или `null` (Python нужен только для APK-обновления).