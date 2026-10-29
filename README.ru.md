# Codex proxy

Локальный gateway Anthropic Messages API клиента Claude Code к native backend подписки Codex (по умолчанию) или напрямую к Claude API (отдельный режим). Для Codex нужен существующий вход Codex CLI, для Claude API — API-ключ. Проект не связан официально с OpenAI или Anthropic.

[English version](README.md)

## Лицензия и происхождение

См. [лицензию MIT](LICENSE).

## Установка

Требуются Node.js >=22.12, npm и отдельно установленный Claude Code. Для режима Codex также нужен Codex CLI.

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

`CLAUDE_PROXY_BACKEND` выбирает backend для всего процесса: `codex-oauth` (по умолчанию) или `anthropic`. Другие значения вызывают ошибку запуска. Для одновременной работы двух backend нужны отдельные процессы на разных портах. Старые переменные выбора provider и auth source игнорируются. В режиме Codex модели должны принадлежать семействам `gpt-` или `codex`; неизвестные providers и семейства отклоняются до fetch. Доступность конкретной модели проверяет backend. Claude aliases используют `CCX_DEFAULT_MODEL`; `@low`, `@medium`, `@high`, `@xhigh`, `@max` задают effort. `[1m]` — маркер клиента без гарантии размера контекста. `CODEX_FORCE_REASONING_EFFORT` фиксирует server effort; compaction ограничивает его значением medium.

В режиме Codex сохраняются text, images, tools, SSE и nonstream ответы. Native web search заменяет WebSearch/WebFetch. Завершённый hidden reasoning хранится в памяти и replay изолирован по session/account/model; перезапуск очищает cache. Ответ буферизуется до завершения, чтобы recovery не дублировал tool execution. По умолчанию network recovery повторяется до отключения клиента; `CCX_NETWORK_RETRIES=0` отключает внешние повторы. Usage разделяет cached и uncached input. Mock-тесты не подтверждают live backend parity.

## Прямой Claude API

В отдельном Bash-терминале выберите свободный порт и передайте API-ключ процессу прокси. Скрытый ввод не сохраняет ключ в истории команд:

```sh
export CLAUDE_PROXY_BACKEND=anthropic
export CLAUDE_PROXY_PORT=17871
read -rsp 'Claude API key: ' ANTHROPIC_API_KEY
printf '\n'
export ANTHROPIC_API_KEY
npm run start:proxy
```

В терминале клиента:

```sh
unset ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN
export ANTHROPIC_BASE_URL=http://127.0.0.1:17871
export ANTHROPIC_AUTH_TOKEN=local-placeholder
export ANTHROPIC_MODEL=claude-opus-5-5
claude
```

Выберите настоящий ID модели Claude API, доступной вашей организации. Уберите из окружения клиента старые Codex-переопределения моделей по умолчанию и размера контекста. Codex aliases и суффиксы `@effort` в этом режиме не преобразуются. Для неинтерактивного запуска используйте `claude -p "Ваш вопрос"`; штатные `--continue` и `--resume` управляют историей диалога. Прокси не создаёт агентные сессии и не выполняет инструменты.

Прокси передаёт `POST /v1/messages` и `POST /v1/messages/count_tokens` вместе с query-параметрами на фиксированный адрес `https://api.anthropic.com`. Используется только серверный `ANTHROPIC_API_KEY`, читаемый при каждом запросе; клиентские authorization, cookies и hop-by-hop заголовки не передаются. Атрибуция клиента, версия API, beta-заголовки и все поля JSON сохраняются. `ANTHROPIC_BASE_URL` не влияет на адрес upstream; редиректы запрещены. Доступы Codex в этом режиме не требуются и не читаются; `/codex/status` отсутствует.

Ответ передаётся потоком без Codex-преобразований и ожидания завершения всего ответа. Сохраняются вызовы инструментов, thinking, usage, ошибки SSE, HTTP-статус, request ID и заголовки лимитов. Отключение клиента отменяет запрос к API; прокси не повторяет запросы. Транспортные ошибки возвращаются общими сообщениями без логирования ключей или промптов. `/healthz` и `/_status` показывают выбранный backend, но не проверяют доступ к API или баланс.

Этот транспорт сохраняет атрибуцию клиента и не меняет применимость кредитов. Anthropic описывает покрытие и исключения в [FAQ о кредитах](https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-and-team-plans); mock-тесты не подтверждают списание баланса или доступ к конкретной модели.

## Файл окон квоты Codex

При заданном `CODEX_PROXY_RATE_LIMITS_FILE` прокси сохраняет окна квоты из заголовков каждого ответа сервера, включая ответы с ошибкой. Каталог файла должен существовать. Формат: `{"capturedAt":1790000000,"five_hour":{"used_percentage":12.5,"resets_at":1790003600},"seven_day":{"used_percentage":34,"resets_at":1790600000}}`. Время выражено в целых секундах Unix, использование — в процентах от 0 до 100.

Окна `x-codex-primary-*` и `x-codex-secondary-*` сопоставляются по `window-minutes`: 300 минут → `five_hour`, 10080 минут → `seven_day`. Сохраняется и единственное окно; отключённые окна (0 минут), неизвестная или отсутствующая длительность пропускаются. Для известного окна нужны полные данные: `used-percent`, `window-minutes` и `reset-at` либо `reset-after-seconds`. Абсолютный `reset-at` имеет приоритет. Имена абсолютных заголовков соответствуют [исходнику Codex CLI](https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/rate_limits.rs).

Неполные, повреждённые или истёкшие значения известного окна сохраняют прежний файл. Если нет ни одного окна известной длительности, файл также остаётся прежним. Запись идёт через временный файл с правами `0600` в том же каталоге и атомарное переименование. Ошибка записи выводит одну строку без приватных данных и не прерывает ответ клиенту. Без переменной окружения запись отключена. Проверка с настоящим сервером выполняется координатором после обновления образа по разделу «Проверка вживую» документа `agent-runtime/node/docs/окна-подписок.md`.

## Проверки

Проверки выполняются с новыми временными каталогами вне проекта, synthetic credentials и mock fetch:

```sh
check_root=$(mktemp -d)
mkdir -p "$check_root/home" "$check_root/codex"
HOME="$check_root/home" CODEX_HOME="$check_root/codex" npm run build
HOME="$check_root/home" CODEX_HOME="$check_root/codex" npm test
HOME="$check_root/home" CODEX_HOME="$check_root/codex" npm pack --dry-run --ignore-scripts
rm -rf "$check_root"
```
