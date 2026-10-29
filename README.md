# Codex proxy

Local gateway from Claude Code's Anthropic Messages API to either the native Codex subscription backend (default) or the Claude API (opt-in). Codex mode requires an existing Codex CLI login; Claude API mode requires an API key. This project is not affiliated with OpenAI or Anthropic.

[Русская версия](README.ru.md)

## License and provenance

See the [MIT license](LICENSE).

## Setup

Requires Node.js 22.12 or newer, npm and Claude Code installed separately. Codex mode also requires Codex CLI.

```sh
git clone https://github.com/advio-tech/codex-proxy.git
cd codex-proxy
npm ci --ignore-scripts --registry=https://registry.npmjs.org
npm run build
```

If needed, the owner runs `codex login` manually beforehand. The proxy only reads `$CODEX_HOME/auth.json` (default `~/.codex/auth.json`), or `CODEX_AUTH_FILE` when explicitly set. It never logs in, refreshes tokens, logs out or writes credentials. Expired or missing credentials return an error; the owner updates them through Codex CLI.

Select an unused loopback port, then run the compiled gateway in the foreground:

```sh
export CLAUDE_PROXY_PORT=17870
export CCX_DEFAULT_MODEL=gpt-6.1-sol@medium
npm run start:proxy
```

In a second terminal, configure Claude Code with the same port:

```sh
export ANTHROPIC_BASE_URL=http://127.0.0.1:17870
export ANTHROPIC_AUTH_TOKEN=local-placeholder
export ANTHROPIC_MODEL=codex-oauth:gpt-6.1-sol@medium
export ANTHROPIC_DEFAULT_OPUS_MODEL="$ANTHROPIC_MODEL"
export ANTHROPIC_DEFAULT_SONNET_MODEL="$ANTHROPIC_MODEL"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="$ANTHROPIC_MODEL"
claude
```

The placeholder is a client requirement, not backend authentication. Use this gateway only with trusted local clients. Check `curl http://127.0.0.1:17870/healthz` for listener health and `/codex/status` for local credential validity. Status does not verify backend acceptance. Stop the foreground gateway with Ctrl+C. An occupied port causes startup failure; no existing listener is reused or killed.

`CLAUDE_PROXY_BACKEND` selects the backend for the whole process: `codex-oauth` (default) or `anthropic`. Other values fail at startup. Run separate processes on different ports to use both backends at once. Legacy provider and auth-source environment variables are ignored. In Codex mode, models must use the `gpt-` or `codex` family; unknown providers and model families fail before fetch. Backend model availability is checked only by the backend. Claude model aliases select `CCX_DEFAULT_MODEL`; `@low`, `@medium`, `@high`, `@xhigh` and `@max` set effort, and `[1m]` is a client marker rather than a context-size guarantee. `CODEX_FORCE_REASONING_EFFORT` can pin server effort; compaction caps it at medium.

In Codex mode, text, images, tools, SSE and nonstream responses are converted. Native web search replaces WebSearch/WebFetch. Completed hidden reasoning is replayed in memory, scoped by session, account and model; restarting clears it. Responses are buffered until completion to avoid duplicate tool execution during connection recovery. Network recovery retries until disconnect by default; `CCX_NETWORK_RETRIES=0` disables outer retries. Usage separates cached from uncached input. No live backend parity is claimed by the mock suite.

## Direct Claude API mode

In a separate Bash terminal, choose a free port and supply the API key to the proxy process. The prompt keeps the key out of shell history:

```sh
export CLAUDE_PROXY_BACKEND=anthropic
export CLAUDE_PROXY_PORT=17871
read -rsp 'Claude API key: ' ANTHROPIC_API_KEY
printf '\n'
export ANTHROPIC_API_KEY
npm run start:proxy
```

In the client terminal:

```sh
unset ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN
export ANTHROPIC_BASE_URL=http://127.0.0.1:17871
export ANTHROPIC_AUTH_TOKEN=local-placeholder
export ANTHROPIC_MODEL=claude-opus-5-5
claude
```

Choose a real Claude API model ID available to your organization. Remove any Codex-specific overrides for default models or context size from the client environment. Codex aliases and `@effort` suffixes are not translated in this mode. For a non-interactive run, use `claude -p "Your question"`; Claude Code's normal `--continue` and `--resume` options manage conversation history. The proxy does not create agent sessions or execute tools.

The proxy forwards `POST /v1/messages` and `POST /v1/messages/count_tokens`, including query parameters, to the fixed origin `https://api.anthropic.com`. It uses only the server's `ANTHROPIC_API_KEY`, read on each request; client authorization, cookies and hop-by-hop headers are not forwarded. Client attribution headers, API version, beta headers and all JSON fields are preserved. `ANTHROPIC_BASE_URL` never changes the upstream origin, and redirects are rejected. No Codex credentials are needed or read; `/codex/status` is absent in this mode.

Responses are streamed without Codex conversion or buffering until completion. This preserves tool calls, thinking, usage, SSE errors, HTTP status, request IDs and rate-limit headers. Disconnecting the client aborts upstream work; the proxy does not retry API requests. Transport errors use generic messages without logging keys or prompts. `/healthz` and `/_status` report the selected backend without validating API access or balance.

This transport preserves client attribution and does not change credit eligibility. Anthropic documents API credit coverage and exclusions in its [credit FAQ](https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-and-team-plans); mock tests do not establish billing behavior or access to a particular model.

## Checks

Run tests with fresh scratch directories outside the checkout. The suite mocks upstream fetch and native credentials:

```sh
check_root=$(mktemp -d)
mkdir -p "$check_root/home" "$check_root/codex"
HOME="$check_root/home" CODEX_HOME="$check_root/codex" npm run build
HOME="$check_root/home" CODEX_HOME="$check_root/codex" npm test
HOME="$check_root/home" CODEX_HOME="$check_root/codex" npm pack --dry-run --ignore-scripts
rm -rf "$check_root"
```
