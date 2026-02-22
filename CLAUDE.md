# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Graph is an MCP server that gives AI agents persistent memory across sessions. Agents decompose work into dependency trees, claim tasks, record evidence, and hand off to the next session automatically. Published as `@graph-tl/graph` on npm.

## Commands

```bash
npm test                    # Run all tests (vitest, ~161 tests across 6 files)
npm run build               # Build with tsup (ESM, node20 target)
npx vitest run test/tools.test.ts  # Run a single test file
npx vitest run -t "creates a new project"  # Run a single test by name
```

## Architecture

**MCP server** (`src/server.ts`) — registers 14 tools, handles tool calls via switch statement, manages version banner and agent file auto-update on first call.

**Tool handlers** (`src/tools/*.ts`) — one file per tool. Each exports a `handleXxx(input, agent)` function. Tools: `open`, `plan`, `next`, `context`, `update`, `connect`, `query`, `restructure`, `history`, `onboard`, `tree`, `status`, `knowledge` (4 sub-tools), `agent-config`.

**Data layer**:
- `db.ts` — SQLite via better-sqlite3, WAL mode, schema migrations. DB is lazy-initialized on first tool call.
- `nodes.ts` — CRUD for nodes (tasks). Handles depth computation, parent-child, project summaries. `rowToNode()` converts SQLite integers/JSON strings to typed objects.
- `edges.ts` — Dependency edges with cycle detection (DFS). `findNewlyActionable()` walks the graph to find nodes unblocked by a resolution.
- `events.ts` — Audit trail. Every mutation logs a timestamped event with field-level changes.
- `types.ts` — Core interfaces: `Node`, `Evidence`, `Edge`, `Event`, `NodeRow` (SQLite row shape).

**Validation** (`validate.ts`) — Two error types: `ValidationError` (bad input) and `EngineError(code, message)` (business logic, e.g. `cycle_detected`, `evidence_required`, `delete_protected`).

**Gating** (`gates.ts`, `license.ts`) — License tier enforcement (free/pro). Gates checked in server.ts before calling handlers.

**CLI** (`index.ts`) — Routes `graph activate`, `graph init`, or starts MCP server (default).

**Continuity** (`continuity.ts`) — Computes continuity confidence score (0-100) from evidence coverage, staleness, knowledge gaps, stale blockers. Used by `onboard` and `status`.

## Key patterns

- **SQLite booleans**: Stored as 0/1, converted to boolean in `rowToNode()`. Always compare with `=== 1` in SQL, not truthy.
- **JSON fields**: `properties`, `context_links`, `evidence` are stored as JSON strings in SQLite, parsed on read.
- **Atomic transactions**: `graph_plan` and `graph_restructure` wrap multi-step operations in `db.transaction()`.
- **Optimistic concurrency**: Nodes have `rev` field. `graph_update` accepts `expected_rev` to detect conflicts.
- **Code annotations**: Key changes are marked with `// [sl:nodeId]` linking code to graph tasks.
- **Tests use `:memory:` SQLite**: `beforeEach(() => initDb(":memory:"))` — fresh DB per test, no cleanup needed.

## Graph workflow

This project uses Graph for its own task tracking. Start every session with `graph_onboard` to see project state, actionable tasks, and continuity confidence. Follow the claim-work-resolve loop: `graph_next` (claim) → do work → `graph_update` (resolve with evidence). Don't execute ad-hoc work — add it to the graph first via `graph_plan`.

- **Every change goes through the graph — no exceptions.** Even small fixes and one-line changes get a node via `graph_plan` before implementation. "It's just a quick fix" is not an excuse to bypass the workflow.
- **Stay focused on what was asked.** Don't propose adjacent work, extra refactors, or "while we're here" improvements. If you notice something worth doing, add it as a graph node silently — don't pitch it to the user.
