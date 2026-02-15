# Swimlanes — Implementation Plan

## Overview
Build an MCP server in TypeScript that implements the 9 tools defined in TOOLS.md.
SQLite storage. Local-only. No UI.

## Phase 1: Foundation
1. **Project scaffolding** — TypeScript, ESM, MCP SDK dependency, SQLite (better-sqlite3), build/dev scripts
2. **Database schema** — three tables: `nodes`, `edges`, `events`. Migrations setup.
3. **Node CRUD layer** — internal functions for creating, reading, updating nodes. Not exposed directly — tools compose these.
4. **Edge management** — internal functions for edges with cycle detection on `depends_on` type.
5. **Event/audit logging** — every mutation writes an event. Internal function, called by all write operations.

## Phase 2: Core Tools
Implement in this order (each builds on the previous):
1. **swimlanes_open** — create/resume/list projects. Needs: node CRUD, basic queries.
2. **swimlanes_plan** — batch create with ref resolution. Needs: node CRUD, edge management, atomic transactions.
3. **swimlanes_update** — modify nodes, compute `newly_actionable`. Needs: dependency graph traversal.
4. **swimlanes_connect** — add/remove edges. Needs: edge management, cycle detection.
5. **swimlanes_context** — deep read with tree traversal. Needs: recursive queries.
6. **swimlanes_query** — filtered search with pagination. Needs: dynamic query building.
7. **swimlanes_next** — ranked actionable node selection. Needs: dependency resolution, ranking logic, soft claims.
8. **swimlanes_restructure** — move, merge, drop. Needs: all of the above.
9. **swimlanes_history** — read audit trail. Needs: events table queries.

## Phase 3: MCP Server
1. **MCP server wrapper** — register all 9 tools with the MCP SDK
2. **Config loading** — agent_identity, db_path, claim_ttl from swimlanes.config.yaml
3. **Error handling** — structured error responses (not crashes) for: node_not_found, cycle_detected, stale_rev, etc.

## Phase 4: Dogfood
1. **Use swimlanes to build swimlanes** — configure Claude Code to use the MCP server, plan remaining work as a swimlanes project
2. **Fix what's broken** — the tool surface WILL need adjustment once a real agent uses it
3. **Token measurement** — verify the budget estimates from TOOLS.md against real usage

## Tech decisions
- **MCP SDK**: `@modelcontextprotocol/sdk`
- **SQLite**: `better-sqlite3` (synchronous, no async overhead for local DB)
- **No ORM** — raw SQL, the schema is simple enough
- **Config**: yaml via `js-yaml` or just JSON, not critical
- **Build**: `tsup` or `tsc`, keep it simple
- **Package manager**: npm

## Database Schema (draft)

```sql
CREATE TABLE nodes (
  id TEXT PRIMARY KEY,
  rev INTEGER NOT NULL DEFAULT 1,
  parent TEXT REFERENCES nodes(id),
  project TEXT NOT NULL,
  summary TEXT NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0,
  state TEXT,                          -- JSON, agent-defined
  properties TEXT NOT NULL DEFAULT '{}', -- JSON
  context_links TEXT NOT NULL DEFAULT '[]', -- JSON array
  evidence TEXT NOT NULL DEFAULT '[]',     -- JSON array of Evidence objects
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE edges (
  id TEXT PRIMARY KEY,
  from_node TEXT NOT NULL REFERENCES nodes(id),
  to_node TEXT NOT NULL REFERENCES nodes(id),
  type TEXT NOT NULL,                  -- "depends_on", "relates_to", custom
  created_at TEXT NOT NULL,
  UNIQUE(from_node, to_node, type)
);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES nodes(id),
  agent TEXT NOT NULL,
  action TEXT NOT NULL,
  changes TEXT NOT NULL,               -- JSON array of {field, before, after}
  timestamp TEXT NOT NULL
);

CREATE INDEX idx_nodes_project ON nodes(project);
CREATE INDEX idx_nodes_parent ON nodes(parent);
CREATE INDEX idx_nodes_resolved ON nodes(project, resolved);
CREATE INDEX idx_edges_from ON edges(from_node);
CREATE INDEX idx_edges_to ON edges(to_node);
CREATE INDEX idx_events_node ON events(node_id);
```

## Open questions for during implementation
- ID generation: UUID v7 (sortable) or short nanoid?
- Should `swimlanes_next` ranking be configurable per-project or hardcoded?
- How to handle `swimlanes_plan` when one node in the batch references a nonexistent parent — fail entire batch or partial success?
- MCP server transport: stdio (for Claude Code) or HTTP+SSE (for broader use)? Probably stdio first.
