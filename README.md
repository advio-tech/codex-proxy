# Codex proxy

Local adapter from Claude Code's Anthropic Messages API to the native Codex subscription backend. It requires an existing Codex CLI login and backend access to the requested model. This project is not affiliated with OpenAI or Anthropic.

[Русская версия](README.ru.md)

## License and provenance

See the [MIT license](LICENSE).

## Setup

Requires Node.js 22.12 or newer, npm, Codex CLI and Claude Code installed separately.

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

Only native Codex is supported. Legacy provider and auth-source environment variables are ignored. Models must use the `gpt-` or `codex` family; unknown providers and model families fail before fetch. Backend model availability is checked only by the backend. Claude model aliases select `CCX_DEFAULT_MODEL`; `@low`, `@medium`, `@high`, `@xhigh` and `@max` set effort, and `[1m]` is a client marker rather than a context-size guarantee. `CODEX_FORCE_REASONING_EFFORT` can pin server effort; compaction caps it at medium.

Text, images, tools, SSE and nonstream responses are converted. Native web search replaces WebSearch/WebFetch. Completed hidden reasoning is replayed in memory, scoped by session, account and model; restarting clears it. Responses are buffered until completion to avoid duplicate tool execution during connection recovery. Network recovery retries until disconnect by default; `CCX_NETWORK_RETRIES=0` disables outer retries. Usage separates cached from uncached input. No live backend parity is claimed by the mock suite.

Run tests with fresh scratch directories outside the checkout. The suite mocks upstream fetch and native credentials:

```sh
check_root=$(mktemp -d)
mkdir -p "$check_root/home" "$check_root/codex"
HOME="$check_root/home" CODEX_HOME="$check_root/codex" npm run build
HOME="$check_root/home" CODEX_HOME="$check_root/codex" npm test
HOME="$check_root/home" CODEX_HOME="$check_root/codex" npm pack --dry-run --ignore-scripts
rm -rf "$check_root"
```
