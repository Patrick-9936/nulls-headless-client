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

Сборка детерминирована: `node_modules/.package-lock.json`, npm-кэши и
`node_modules/.bin` в бандл не попадают, gzip пишется с `mtime=0`, отметки
времени в zip фиксированы. Одинаковые исходники дают одинаковый sha256.

Проверить, что закоммиченный `Nulls.js` соответствует исходникам, можно без
перезаписи файлов:

```sh
npm run bundle:check  # python3 tools/package_release.py --check
```

Режим `--check` собирает zip и бандл во временную папку (`$TMPDIR`), сравнивает
sha256 с `Nulls.js` в корне и печатает JSON с полями `check`, `expected_sha256`,
`committed_sha256`, `changed`. Код возврата 0 — всё совпало, 1 — есть различия.

## 3. Проверки перед коммитом

```sh
npm test                       # node --test, все тесты должны быть зелёными
npm run check                  # синтаксис + node Program.js info
npm run lint                   # только проверка синтаксиса
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
3. `npm ci --ignore-scripts`, `npm test`, `npm run check`,
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