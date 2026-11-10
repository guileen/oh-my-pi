# @oh-my-pi/pi-coding-agent

Core implementation package for the `omp` coding agent in the `omp` monorepo.

For installation, setup, provider configuration, model roles, slash commands, and full CLI reference, see:

- [Monorepo README (local)](../../README.md)
- [Monorepo README (GitHub)](https://github.com/can1357/oh-my-pi#readme)

Package-specific references:

- [CHANGELOG](./CHANGELOG.md)
- [MCP configuration guide](../../docs/mcp-config.md)
- [MCP runtime lifecycle](../../docs/mcp-runtime-lifecycle.md)
- [MCP server/tool authoring](../../docs/mcp-server-tool-authoring.md)
- [Named Bots and Graph observability](../../docs/bot-observability-spec.md)
- [DEVELOPMENT](./DEVELOPMENT.md)

## Named headless Bots

Bots are fixed capability definitions; each submission creates an isolated Job. No coding-agent prompt, project rules, tools, Skills or extensions load unless configured.

```bash
omp bot create reviewer --system-prompt ./reviewer.md --tools read,grep --cwd ./project
omp bot reviewer submit "Review cancellation behavior" --request-key review-123 --json
omp bot reviewer watch JOB_ID --json
omp bot reviewer send JOB_ID "Check timeout cleanup" --json
omp bot reviewer compact JOB_ID --mode qaonly --json
omp bot reviewer stop JOB_ID --json
```

Submission/control receipts return before model completion. Query `request REQUEST_ID` for application and `status JOB_ID` for execution state; `idle` is not business acceptance. Observers can reconnect using `watch --since '<cursor>'`. Work survives viewer disconnection; filesystem/network isolation remains the caller's sandbox responsibility. See the [command and wire contract](../../docs/bot-observability-spec.md).

For automation, pass `--expect-bot-id BOT_ID` on named operations and `inspect REF --job JOB_ID` for scoped details. Snapshots advertise supported capabilities and include recoverable questions, reply reservations and execution ownership. Compaction waits safely for required answers; timeout/background continuations reacquire Bot capacity. A stopped Job can retain a closed activation reference as history.

The Bot database upgrades to schema 2 with a private standalone backup; stop legacy workers first. Existing IDs, request keys and historical references survive. Uncertain crash-owned work requires reconciliation, never automatic replay. External Graph/PWA integration remains separate and requires its actual host repository.

Runtime verification and remaining external integration gates are tracked in [OpenSpec: harden-bot-graph-observation](../../openspec/changes/harden-bot-graph-observation/tasks.md). Existing herdr terminal support is not a Graph PWA adapter.

## Memory backends

The agent supports three mutually-exclusive memory backends, selected via the `memory.backend` setting (Settings → Memory tab, or `~/.omp/config.yml`):

- `off` (default) — no memory subsystem runs.
- `local` — existing rollout-summarisation pipeline; writes `memory_summary.md` and consolidated artifacts under the agent dir.
- `hindsight` — talks to a [Hindsight](https://hindsight.vectorize.io) server (Cloud or self-hosted Docker), retains transcripts every Nth user turn, recalls memories on the first turn of a session, and exposes `retain`, `recall`, and `reflect`.

### Hindsight quickstart

1. Run a Hindsight server (Cloud or `docker run -p 8888:8888 ghcr.io/vectorize-io/hindsight:latest`).
2. Set `memory.backend = "hindsight"` and `hindsight.apiUrl = "http://localhost:8888"` (or your Cloud URL).
3. Optional environment overrides (env wins over settings):
   - `HINDSIGHT_API_URL`, `HINDSIGHT_API_TOKEN` — connection
   - `HINDSIGHT_BANK_ID`, `HINDSIGHT_DYNAMIC_BANK_ID`, `HINDSIGHT_AGENT_NAME` — bank addressing
   - `HINDSIGHT_AUTO_RECALL`, `HINDSIGHT_AUTO_RETAIN`, `HINDSIGHT_RETAIN_MODE` — lifecycle
   - `HINDSIGHT_RECALL_BUDGET`, `HINDSIGHT_RECALL_MAX_TOKENS` — recall sizing
   - `HINDSIGHT_BANK_MISSION`, `HINDSIGHT_DEBUG`

Switching backends mid-session immediately replaces the live backend, memory tools, listeners, and system-prompt context. Existing users with `memories.enabled = true|false` are migrated to `memory.backend = "local"|"off"` exactly once on first launch; afterward, `memory.backend` is the sole runtime selector.
