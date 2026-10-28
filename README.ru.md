# Codex proxy

Локальный адаптер Anthropic Messages API клиента Claude Code к native backend подписки Codex. Нужны существующий вход Codex CLI и доступ backend к выбранной модели. Проект не связан официально с OpenAI или Anthropic.

[English version](README.md)

## Лицензия и происхождение

См. [лицензию MIT](LICENSE).

## Установка

Требуются Node.js >=22.12, npm и отдельно установленные Codex CLI и Claude Code.

```sh
git clone https://github.com/advio-tech/codex-proxy.git
cd codex-proxy
npm ci --ignore-scripts --registry=https://registry.npmjs.org
npm run build
```

При необходимости владелец заранее выполняет `codex login` вручную. Proxy только читает `$CODEX_HOME/auth.json` (по умолчанию `~/.codex/auth.json`) либо явно заданный `CODEX_AUTH_FILE`. Он не выполняет вход, refresh, logout или запись credentials. Отсутствующий либо просроченный token вызывает ошибку; владелец обновляет его средствами Codex CLI.

Выберите свободный loopback-порт и запустите собранный gateway на переднем плане:

```sh
export CLAUDE_PROXY_PORT=17870
export CCX_DEFAULT_MODEL=gpt-6.1-sol@medium
npm run start:proxy
```

Во втором терминале настройте Claude Code на тот же порт:

```sh
export ANTHROPIC_BASE_URL=http://127.0.0.1:17870
export ANTHROPIC_AUTH_TOKEN=local-placeholder
export ANTHROPIC_MODEL=codex-oauth:gpt-6.1-sol@medium
export ANTHROPIC_DEFAULT_OPUS_MODEL="$ANTHROPIC_MODEL"
export ANTHROPIC_DEFAULT_SONNET_MODEL="$ANTHROPIC_MODEL"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="$ANTHROPIC_MODEL"
claude
```

Placeholder нужен клиенту и не служит аутентификацией backend. Используйте gateway только с доверенными локальными клиентами. `curl http://127.0.0.1:17870/healthz` проверяет listener; `/codex/status` показывает локальную валидность credentials без проверки их принятия backend. Ctrl+C останавливает foreground gateway. Занятый порт вызывает ошибку запуска; существующий listener не переиспользуется и не завершается.

Поддерживается только native Codex. Старые переменные выбора provider и auth source игнорируются. Модели должны принадлежать семействам `gpt-` или `codex`; неизвестные providers и семейства отклоняются до fetch. Доступность конкретной модели проверяет backend. Claude aliases используют `CCX_DEFAULT_MODEL`; `@low`, `@medium`, `@high`, `@xhigh`, `@max` задают effort. `[1m]` — маркер клиента без гарантии размера контекста. `CODEX_FORCE_REASONING_EFFORT` фиксирует server effort; compaction ограничивает его значением medium.

Сохраняются text, images, tools, SSE и nonstream ответы. Native web search заменяет WebSearch/WebFetch. Завершённый hidden reasoning хранится в памяти и replay изолирован по session/account/model; перезапуск очищает cache. Ответ буферизуется до завершения, чтобы recovery не дублировал tool execution. По умолчанию network recovery повторяется до отключения клиента; `CCX_NETWORK_RETRIES=0` отключает внешние повторы. Usage разделяет cached и uncached input. Mock-тесты не подтверждают live backend parity.

### Файл окон квоты

При заданном `CODEX_PROXY_RATE_LIMITS_FILE` прокси сохраняет окна квоты из заголовков каждого ответа сервера, включая ответы с ошибкой. Каталог файла должен существовать. Формат: `{"capturedAt":1790000000,"five_hour":{"used_percentage":12.5,"resets_at":1790003600},"seven_day":{"used_percentage":34,"resets_at":1790600000}}`. Время выражено в целых секундах Unix, использование — в процентах от 0 до 100.

Окна `x-codex-primary-*` и `x-codex-secondary-*` сопоставляются по `window-minutes`: 300 минут → `five_hour`, 10080 минут → `seven_day`. Сохраняется и единственное окно; отключённые окна (0 минут), неизвестная или отсутствующая длительность пропускаются. Для известного окна нужны полные данные: `used-percent`, `window-minutes` и `reset-at` либо `reset-after-seconds`. Абсолютный `reset-at` имеет приоритет. Имена абсолютных заголовков соответствуют [исходнику Codex CLI](https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/rate_limits.rs).

Неполные, повреждённые или истёкшие значения известного окна сохраняют прежний файл. Если нет ни одного окна известной длительности, файл также остаётся прежним. Запись идёт через временный файл с правами `0600` в том же каталоге и атомарное переименование. Ошибка записи выводит одну строку без приватных данных и не прерывает ответ клиенту. Без переменной окружения запись отключена. Проверка с настоящим сервером выполняется координатором после обновления образа по разделу «Проверка вживую» документа `agent-runtime/node/docs/окна-подписок.md`.

Проверки выполняются с новыми временными каталогами вне проекта, synthetic credentials и mock fetch:

```sh
check_root=$(mktemp -d)
mkdir -p "$check_root/home" "$check_root/codex"
HOME="$check_root/home" CODEX_HOME="$check_root/codex" npm run build
HOME="$check_root/home" CODEX_HOME="$check_root/codex" npm test
HOME="$check_root/home" CODEX_HOME="$check_root/codex" npm pack --dry-run --ignore-scripts
rm -rf "$check_root"
```
