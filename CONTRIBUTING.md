# Как контрибьютить

Короткий рабочий порядок: поднять окружение, сделать правку, прогнать тесты, открыть PR с описанием того, что проверено. Всё, что ниже, — обязательный минимум, а не пожелание.

## 1. Окружение

Нужен Node.js 20 или новее (CI гоняет 20, 22, 24). Проверка: `node -v`.

```sh
git clone https://github.com/Patrick-9936/nulls-headless-client.git
cd nulls-headless-client
npm ci --ignore-scripts
```

`--ignore-scripts` обязателен: установка не должна запускать чужие postinstall-хуки. Зависимости проекта — `blakejs`, `colors`, `tweetnacl`; для разработки ставятся `eslint`, `globals` и `prettier` (`devDependencies`). В бандл и zip попадают только production-зависимости, dev-дерево в релиз не идёт.

Основные команды:

| Команда | Что делает |
|---|---|
| `npm test` | все тесты (`node --test tests/*.test.js`), ожидается 168+ pass |
| `node --test tests/<file>.test.js` | один файл тестов |
| `npm run check` | синтаксис ключевых файлов + `node Program.js info` |
| `npm run lint` | eslint по всему дереву (`eslint .`) |
| `npm run format:check` | prettier в режиме проверки |
| `node Nulls.js --self-test` | проверка собранного бандла: разбор встроенных модулей |

Один тест во время работы — самый быстрый цикл:

```sh
node --test tests/candidates.test.js
node --test tests/club-protocol.test.js
```

Тесты не ходят в сеть: сервер и прокси подменяются фейками. Если ваш тест требует сети, он не может быть в наборе.

## 2. Стиль

В репозитории уже лежат конфиги — ничего не изобретайте:

- `.prettierrc.json` — `printWidth 120`, `singleQuote`, `semi`, `trailingComma: all`, `arrowParens: always`, LF;
- `.prettierignore` — что форматировать не нужно (бандл, документация, данные, состояние);
- `eslint.config.mjs` — плоский конфиг, только встроенные правила, без плагинов;
- `.editorconfig` — utf-8, LF, два пробела, финальный перевод строки.

Форматируйте **только изменённые файлы**, не весь репозиторий:

```sh
npx prettier --write lib/MyFile.js
npx prettier --check lib/MyFile.js
```

Массовое форматирование (`prettier --write .`) в PR не принимается: оно превращает содержательную правку в тысячестрочный diff и делает ревью невозможным. Если форматирование нужно всему репозиторию — это отдельный PR, согласованный заранее.

Линтер установлен как devDependency, запуск — `npm run lint` (`eslint .`). Конфиг плоский, без плагинов, `ecmaVersion: 2023`, `sourceType: 'commonjs'`; dev-файлы и `Nulls.js` не проверяются. В CI ошибки валят сборку, предупреждения — нет. Правила, которые ломают сборку: `no-undef`, `no-var`, `no-throw-literal`, `no-cond-assign`, `no-self-assign`, `no-unreachable`, `no-dupe-keys`, `no-redeclare`. `no-unused-vars`, `prefer-const`, `eqeqeq` и `no-empty` дают предупреждения: пустой `catch` в best-effort очистке (`catch {}` вокруг закрытия сокета или таймера) допустим, но не в декодерах — там нужен лог причины или проброс.

## 3. Правила кода

- **Ошибки — значения или исключения на границе.** Внутри декодеров допустим `throw`; вызывающий превращает его в событие `warning`. Молчаливый `catch {}` запрещён — логируйте причину через `Debugger.warn` или пробрасывайте.
- **Границы буферов.** Любой внешний размер проверяется до аллокации. Число элементов из пакета не используется как длина массива без максимального значения (`count(s, maximum)`).
- **Без «доверенных» длин.** `readBytes`, `readString`, `readByteArray` проверяют `remaining()` — не обходите их прямым доступом к `payload`.
- **API-совместимость.** Публичные контракты для внешних скриптов перечислены в [docs/SCRIPTS.md](docs/SCRIPTS.md). Их изменение — только с мажорной версией.
- **Никаких секретов в коде и логах.** Токены аккаунтов, содержимое `accounts/*.json`, `.runtime/connect.json` не печатаются даже в отладочном режиме.

## 4. Что обязан содержать PR

1. **Описание изменения и причина.** Что было не так, что стало.
2. **Тест на изменение протокола.** Любая новая команда, новый пакет, новый декодер — тест в `tests/`. Валидный кадр, обрезанный кадр, лишние байты. Без теста протокольная правка не принимается.
3. **Обновление документации.** Новая команда → строка в `docs/COMMANDS.md` и запись в `docs/features.json` (`command`, `status`, `experimental`). Новый слой или изменённый контракт → `docs/ARCHITECTURE.md`.
4. **Зелёные прогоны.** `npm test`, `npm run check`, `npm run lint` (0 ошибок eslint), `node Nulls.js --self-test` — приложите вывод или хотя бы итоговые строки.
5. **Никаких `accounts/`, `.runtime/`, логов и дампов в коммите.** Эти пути в `.gitignore`; если файл всё же попал — уберите его из индекса.
6. **Никакой пересборки бандла в PR.** `Nulls.js` собирается релизным workflow (`tools/package_release.py`), не руками участника. Коммит с изменённым `Nulls.js` отклоняется — это ломает детерминированную сборку и `npm run bundle:check`.
7. **Никаких изменений формата `accounts/*.json` без миграции.** Если структура аккаунта меняется, добавьте код, читающий старый формат, и опишите миграцию в описании PR.

## 5. Формат коммитов

Одна логическая правка — один коммит. Сообщение в повелительном наклонении, на русском или английском, но одинаково по всему PR:

```
Add club-online presence decode

- разбор 20207 в Decode.clubOnline
- тест на обрезанный кадр
- строка в docs/COMMANDS.md
```

Смешивать форматирование, рефакторинг и функциональность в одном коммите не нужно: ревью идёт по diff.

## 6. Секреты

- Никогда не коммитьте `accounts/*.json` — там `passToken`.
- Никогда не коммитьте `.runtime/connect.json`: это токен авторизации, файл создаётся с правами `0600` и не должен покидать машину.
- Не вставляйте токены в issue, логи, скриншоты и описания PR. Если токен утёк — удалите аккаунт и создайте новый: отозвать его нельзя.
- `client-license.bin` в репозитории — блок лицензии из APK, он публичный. Токены аккаунтов к нему отношения не имеют.

## 7. Перед открытием PR

```sh
npm ci --ignore-scripts
npm test
npm run check
npm run lint
node Nulls.js --self-test
npx prettier --check $(git diff --name-only --diff-filter=ACMR -- '*.js' '*.json' '*.mjs')
git status --porcelain
```

`git status` не должен показывать `accounts/`, `.runtime/`, `PacketsDumps/`, `fleet-status.json`, `working-proxies.json` и изменённый `Nulls.js`. Dev-зависимости (`eslint`, `globals`, `prettier`) в бандл не попадают — это проверяет `npm run bundle:check` и тест `tests/packaging.test.js`.

## 8. Дальше

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — слои, путь пакета, где расширять.
- [docs/SCRIPTS.md](docs/SCRIPTS.md) — контракт для внешних скриптов.
- [docs/RELEASING.md](docs/RELEASING.md) — порядок выпуска и сборки бандла.
- [docs/VERIFICATION.md](docs/VERIFICATION.md) — что подтверждено на живом сервере.
- [docs/COMMANDS.md](docs/COMMANDS.md) — команды и параметры.