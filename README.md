# agent-memory-minimal

Minimal local MCP memory server for coding agents (OpenCode, Claude Code, etc.). Three tools, no daemons, ports, or secrets — just MCP stdio, SQLite, and local embeddings.

- `memory_write` — store a single fact (title, content, tags as `namespace:value`).
- `memory_search` — hybrid search (keyword FTS5 + vector, multilingual).
- `memory_list` — recent entries, filtered by tags. Cheap call: the model is not loaded.

Cold watcher — **~19MB private memory** (WS ~52MB, the rest is shared). The embedding worker lives only for the duration of a request, with at most one peak worker per machine.

## Why

Full-featured memory servers ship dozens of tools: session captures, consolidations, replay, timelines, governance, viewers, and engines on separate ports. For a working workspace only two operations are actually used:

- Startup sync — narrow recall of rules, active tasks, and decisions (`Workspace_Global_Rules`, `Active_Tasks`, `Dataset_Decision_*`).
- Write — one valuable fact with a project prefix.

Extra tools cost tokens in the system prompt on every message, risk calling the wrong search, and add breakage surface on upgrade. Here the toolset is fixed at three tools with a strict contract: one record — one fact, tags strictly `namespace:value`, decisions as `Dataset_Decision_*` with SCOPE/RULE/SOURCES/RATIONALE/SUPERSEDES/DATE fields.

## Installation

Requirements: Node 20+.

```bash
git clone https://github.com/ilgizar-valiullin/agent-memory-minimal.git
cd agent-memory-minimal
npm install
npm run build
npm run bootstrap   # one-time model cache warmup (~152MB), then offline
```

## Setup

OpenCode (`opencode.json`):

```json
{
  "mcp": {
    "minimal-memory": {
      "type": "local",
      "command": ["node", "--jitless", "--optimize-for-size", "--max-old-space-size=64", "D:/Projects/agent-memory-minimal/dist/watcher.js"],
      "enabled": true
    }
  }
}
```

Any MCP client with stdio transport: use the command above, working directory does not matter, all paths go through env/APPDATA.

Environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `AGENT_MEMORY_DIR` | `%APPDATA%/agent-memory-minimal` (win), `~/Library/Application Support/...` (mac), `~/.local/share/...` (linux) | Data root |
| `AGENT_MEMORY_DB` | `<DIR>/memory.sqlite` | Database file |
| `AGENT_MEMORY_MODEL_CACHE` | `<DIR>/models` | Model cache |
| `AGENT_MEMORY_MODEL` | `Xenova/multilingual-e5-small` | Embedding model |
| `AGENT_MEMORY_IDLE_TIMEOUT_MS` | `0` | 0 — kill the worker right after use; >0 — keep it warm |
| `AGENT_MEMORY_HOT_IDLE_TIMEOUT_MS` | `0` | Same for the hot backend |
| `AGENT_MEMORY_SLOT_TIMEOUT_MS` | `30000` | Wait time for the inter-process embedding slot |

## Architecture

Three processes, each living only while needed:

```text
OpenCode (stdio, newline-JSON)
  |
  v
watcher.js — zero-dep facade (~19MB private), waits for a command.
  Answers itself: initialize / tools/list / ping.
  The first tools/call spins up hot.js and proxies to it.
  |
  v
hot.js — all logic (~60/45MB transient, 0 when idle):
  SQLite (WAL) + FTS5 + sqlite-vec vec0 + validation + RRF fusion.
  Exits when there are no active calls.
  |
  v (only for the duration of embedding)
embed-worker.js — @xenova/transformers, e5-small, prefixes
  passage:/query:. ~740MB transient. Inter-process mutex
  (embed.lock, O_EXCL): peak — 1 worker per machine.
```

Why not Qdrant/Milvus/pgvector: they need Docker/Postgres/a cluster. For three tools that is extra ops. A SQLite file covers WAL parallelism of several instances (verified: 2 processes × 30 concurrent writes — 60/60, `integrity_check: ok`).

Why `multilingual-e5-small` (384 dim, as before): noticeably better Russian retrieval than MiniLM (measured A/B on live queries), English does not regress. The cost is the XLM-R embedding table (~250k tokens): ~740MB transient instead of ~176MB for MiniLM. With the "kill right after use" policy this is only a peak during the request.

## Benchmarks (Windows, NVMe)

- Cold watcher: WS 52MB / Private 19MB (bare node 53/20 — the watcher is near the floor).
- `tools/list`: ~110ms, spawns nothing.
- Cold search: ~0.8–2.5s (hot + worker spin-up + inference).
- 2 watchers × simultaneous cold search: both top-1, worker peak 1, 0 processes after 3s.
- Parallel writes: 60/60 with no `SQLITE_BUSY` leaking out.

## Migration from the old backend

```bash
# 1. Export the old server to export.json (array of {title, content, tags})
node scripts/migrate.mjs export.json --dry-run
node scripts/migrate.mjs export.json
```

The script migrates records, validates the contract (drops empty ones with a counter), and writes via `memory_write` so vectors are recomputed with the new model.

## Development

```bash
npm run build        # tsc -> dist/
npm run test:stdio   # write -> search -> list over stdio
```

## Donations / Support the Project

* **EVM Address** (USDT, USDC, ETH, BNB): `0x3acf78e721aa065bd1509735a3ace630fcd0f452`

  _Supported networks: BNB Smart Chain (BEP20), Polygon, Arbitrum One, Ethereum (ERC20)_
  <details>
  <summary>Show EVM QR Code</summary>
  <img src=".github/images/evm.jpg" width="300" alt="EVM Deposit QR">
  </details>

* **USDT (TRC20)**: `TMG1BZJswd8UacHANKVi9Veq5FqSbaMjAQ`

  _Supported network: Tron (TRC20)_
  <details>
  <summary>Show TRC20 QR Code</summary>
  <img src=".github/images/trc20.jpg" width="300" alt="TRC20 Deposit QR">
  </details>

* **TON / USDT (TON)**: `UQDjf84AZSwuCPC3UWFv28p-V44zI-1lfhqCMfaex2Q-jDsY`

  _Supported network: The Open Network (TON)_
  <details>
  <summary>Show TON QR Code</summary>
  <img src=".github/images/ton.jpg" width="300" alt="TON Deposit QR">
  </details>

## License

MIT
