# Выпуск версии

Внутренний порядок выпуска headless-клиента Nulls: от правок в `main` до
GitHub Release с zip и однофайловым бандлом.

## 1. Подготовка версии

1. Поднять версию в `package.json` (`"version": "0.2.8"`). Версия — источник
   истины: из неё берутся имя архива (`nulls-headless-client-<версия>.zip`),
   константа `VERSION` внутри `Nulls.js` и тег релиза.
2. В `CHANGELOG.md` перенести пункты из `## Unreleased` в новую секцию
   `## [0.2.8] — ГГГГ-ММ-ДД`, оставив `Unreleased` пустым. Формат — Keep a
   Changelog: разделы «Добавлено», «Изменено», «Исправлено», «Удалено».
3. Обновить `docs/features.json`: поля `version` и `date`, при необходимости —
   статусы команд, которые реально проверялись.
4. Если менялся протокол или условия сервера — обновить `docs/VERIFICATION.md`
   (его ведут отдельно от этого документа).

## 2. Сборка бандла

```sh
npm ci --ignore-scripts
npm run bundle        # python3 tools/package_release.py
```

Скрипт делает две вещи:

- `../nulls-headless-client-<версия>.zip` и `../nulls-headless-client-<версия>.zip.sha256`
  в родительской папке репозитория (рядом с клоном, не внутри него);
- `Nulls.js` в корне репозитория и в родительской папке плюс `Nulls.js.sha256`.

Сборка воспроизводима: в бандл и zip попадают только production-зависимости из
`dependencies` (`blakejs`, `colors`, `tweetnacl` и их транзитивное дерево); пакеты с
`dev: true`/`devOptional` из `package-lock.json` исключаются целиком, поэтому
`eslint`, `globals` и их зависимости релиз не раздувают. `node_modules/.package-lock.json`,
npm-кэши и `node_modules/.bin` тоже не попадают, gzip пишется с `mtime=0`, отметки
времени в zip фиксированы, поэтому архив собирается байт-в-байт на любой машине.
Содержимое `Nulls.js` сверяется по хешу распакованного бандла: сам gzip-поток
зависит от версии zlib, поэтому байты файла на ARM и x64 могут отличаться при
идентичных исходниках — это не расхождение.

Проверить, что закоммиченный `Nulls.js` соответствует исходникам, можно без
перезаписи файлов:

```sh
npm run bundle:check  # python3 tools/package_release.py --check
```

Режим `--check` собирает zip и бандл во временную папку (`$TMPDIR`), сравнивает
sha256 с `Nulls.js` в корне и печатает JSON с полями `check`, `expected_sha256`,
`committed_sha256`, `changed`. Код возврата 0 — всё совпало, 1 — есть различия.

### Состав бандла

Релиз — это рабочий клиент, а не копия репозитория. В zip и в `Nulls.js` входят:

- корневые `Program.js`, `TUI.js`, `package.json`, `package-lock.json`,
  `config.json`, `client-license.bin`, `.gitignore`;
- деревья `Crypto/`, `DataStream/`, `Messaging/`, `utils/`, `lib/` (включая
  `lib/locales/*.json`), `data/` (`brawlers`, `regions`, `maps`,
  `club-badges`, `team-errors`), `tools/`;
- production-пакеты `node_modules` (см. выше);
- ровно четыре файла из `docs/` — те, что код читает в рантайме:
  - `docs/features.json` — `lib/CLI.js` (команда `features`) и `TUI.js`;
  - `docs/protocol-evidence.json` — `lib/Protocol.js` (`encode`, версии пакетов);
  - `docs/TUI.md`, `docs/COMMANDS.md` — `TUI.js`, пункты меню «руководство» и
    «команды».

Allowlist задан в `tools/package_release.py` константой `DOC_FILES`; `verify_zip()`
требует, чтобы набор `docs/` в архиве совпадал с ней, а `tests/` и
`docs/native/` отсутствовали. Те же проверки делает `tests/packaging.test.js`.
`tests/` наоборот обязан присутствовать: `node Nulls.js --test` запускает
встроенный набор из однофайлового клиента.

Не входят в релиз (и не должны попадать обратно):

- `docs/native/` — 160 файлов выдержек дампов для разработки;
- `docs/native/` — 160 файлов выдержек дампов для разработки;
- остальные `docs/*.md`, `docs/VERIFICATION.md`, `docs/RELEASING.md` —
  документация для людей (код их не читает);
- `README.md`, `PROTOCOL-MAP.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `LICENSE`
  остаются в репозитории, но не пакуются.

Размеры до/после перехода на allowlist (версия 0.3.3, Termux/ARM; замер сразу
после смены набора файлов, без учёта последующих правок в `lib/`):

| Артефакт | Было | Стало | Экономия |
| --- | --- | --- | --- |
| `Nulls.js`, байт | 1 127 018 | 652 470 | −474 548 (42 %) |
| zip, байт | 729 953 | 391 913 | −338 040 (46 %) |
| файлов в бандле | 379 | 136 | −243 |
| из них `tests/` | 60 | 0 | −60 |
| из них `docs/native/` | 160 | 0 | −160 |
| из них прочие `docs/*.md` | 23 | 0 | −23 |
| из них `docs/` всего | 185 (666 417 Б) | 4 (39 730 Б) | −181 |

## 3. Проверки перед коммитом

```sh
npm test                       # node --test, все тесты должны быть зелёными
npm run check                  # синтаксис + node Program.js info
npm run lint                   # eslint, 0 ошибок (предупреждения не валят)
npm run format:check           # prettier 3, проверка форматирования
node Nulls.js --self-test      # проверка payload и всех .js внутри бандла
python3 tools/package_release.py --check
```

`--check` должен вернуть код 0. Если он показывает расхождения после сборки —
значит `Nulls.js` не пересобран или в дерево попал файл, который не должен
попадать в релиз.

## 4. Коммит и тег

```sh
git add package.json CHANGELOG.md docs/features.json Nulls.js
git commit -m "release: 0.2.8"
git push origin main
git tag -a v0.2.8 -m "0.2.8"
git push origin v0.2.8
```

Бандл коммитится вместе с исходниками — так `node Nulls.js` работает сразу
после клонирования, а CI проверяет, что он не отстал.

## 5. Что делает release.yml

Файл `.github/workflows/release.yml` запускается на push тега `v*` и вручную
(`workflow_dispatch`, можно передать тег; по умолчанию берётся
`v<версия из package.json>`). Шаги:

1. `actions/checkout` (полная история — нужна для запасного тела релиза),
   `actions/setup-node` 22, `actions/setup-python` 3.12;
2. сверяет тег с версией в `package.json` и падает при расхождении;
3. `npm ci --ignore-scripts`, `npm test`, `npm run check`, `npm run lint`,
   `node Nulls.js --self-test`;
4. `python3 tools/package_release.py` — сборка zip и бандла;
5. складывает в `dist/` zip, его `.sha256`, `Nulls.js` и `Nulls.js.sha256` и
   проверяет их через `sha256sum -c`;
6. собирает тело релиза: секцию `## [<версия>]` из `CHANGELOG.md`, а если её
   нет — последние 20 коммитов из `git log`;
7. `gh release create` с четырьмя файлами. Если релиз уже существует,
   обновляет тело через `gh release edit` и перезаливает файлы
   `gh release upload --clobber`. Версии с суффиксом (например `0.3.0-rc.1`)
   помечаются как prerelease.

Права — `contents: write`, сторонних action нет, только официальные и `gh` CLI
из образа runner'а.

## 6. Проверка скачанного релиза

```sh
sha256sum -c nulls-headless-client-0.2.8.zip.sha256
sha256sum -c Nulls.js.sha256
```

Обе команды должны сказать `OK`. Хэш в `.sha256`-файле — это sha256 самого
файла; `Nulls.js --self-test` дополнительно печатает sha256 распакованного
payload (в поле `sha256`), это другой хэш, он проверяет целостность встроенных
файлов, а не самого скрипта.

## 7. Откат релиза

Если релиз собран из плохого коммита:

```sh
gh release delete v0.2.8 --yes --cleanup-tag   # удалить релиз и тег
git push origin :refs/tags/v0.2.8              # если тег остался
```

Затем откатить `main` к рабочему коммиту (`git revert` предпочтительнее
`reset --hard`, если коммит уже в общей ветке), пересобрать бандл
(`npm run bundle`), выпустить исправленную версию с новым номером и тегом.
Переиспользовать старый номер версии не нужно: тег и версия в `package.json`
должны совпадать, а workflow это проверяет.

Локальная копия при неудачном обновлении конфигурации откатывается самим
клиентом: `node tools/update.js --rollback` берёт последний бэкап из
`.updates/backups/`.

## NOTICE

Проект неофициальный: он не связан с Supercell и Nulls Brawl, не одобрен и не
поддерживается ими. Права на игру, клиент, серверы и ассеты принадлежат
правообладателям. MIT из `LICENSE` покрывает только исходный код этого
репозитория; `client-license.bin`, содержимое APK, дампы пакетов и извлечённые
игровые данные под MIT не попадают и используются только для совместимости и
исследования протокола.