# Development

Use Node.js >=22.12. Read package scripts and the lockfile first. Install with `npm ci --ignore-scripts --registry=https://registry.npmjs.org`; build before tests or runtime. Run the complete Vitest suite and inspect `npm pack --dry-run --ignore-scripts`.

For checks, use fresh HOME and CODEX_HOME directories outside the project, mock upstream fetch and synthetic credentials, and dynamically allocated loopback ports. Never read real credentials or conversations. Never perform login, refresh, logout or live backend calls without the owner's explicit approval. Do not bypass permissions, reuse unknown listeners, kill other processes or change system installations.

Keep native-only routing, SSE, tools, nonstream aggregation, reasoning replay, account/model/session affinity and usage conversion intact. Code, comments, logs, tests and README.md are English; README.ru.md is the Russian counterpart. Keep private reports and scanners outside the source tree. Package only compiled adapters, the two READMEs, the package manifest and LICENSE; do not include credentials, state, logs, prompts or private reports.

This is a public source repository. Commit, push, create PRs or publish packages only when the owner explicitly requests it. Do not fabricate or backdate development history. Before publication, verify that no credentials, internal reports or private data are included, and preserve upstream license notices.
