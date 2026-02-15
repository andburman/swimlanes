# Graph

Agent-native persistent task graph. Not an issue tracker — a structured reasoning substrate for agents.

Agents create, decompose, execute, and replan work across sessions. Humans initiate work or supervise; agents do everything else.

## Why

Traditional issue trackers (Jira, Linear) are built around human constraints: columns, boards, discrete states, flat priority. When agents talk to them via MCP, they waste tokens on UI metadata and require 6+ round trips for simple workflows.

Graph gives agents what they actually need:
- **Persistent task graph** — survives across sessions
- **Arbitrary nesting** — agents decompose as deep as needed
- **Explicit dependencies** — with cycle detection
- **Server-side ranking** — one call to get the next actionable task
- **~500 tokens** for a full claim-work-resolve cycle (vs ~5000+ with Linear MCP)

## Install

```bash
git clone https://github.com/andburman/graph.git
cd graph
npm install
npm run build
```

## Configure

Add to your Claude Code MCP config (`.mcp.json` in your project root):

```json
{
  "mcpServers": {
    "graph": {
      "command": "node",
      "args": ["/path/to/graph/dist/index.js"],
      "env": {
        "GRAPH_AGENT": "claude-code",
        "GRAPH_DB": "/path/to/graph.db"
      }
    }
  }
}
```

Environment variables:
- `GRAPH_AGENT` — agent identity, attached to all writes (default: `default-agent`)
- `GRAPH_DB` — SQLite database path (default: `./graph.db`)
- `GRAPH_CLAIM_TTL` — soft claim expiry in minutes (default: `60`)

## Tools

### graph_open
Open or create a project. No args = list all projects.

### graph_plan
Batch create nodes with parent-child and dependency relationships. Atomic.

### graph_next
Get the next actionable node — unresolved leaf, all deps resolved, ranked by priority/depth/recency. Optional soft claim.

### graph_context
Deep-read a node: ancestors, children tree, dependency graph.

### graph_update
Update nodes: resolve, change state, add evidence/context links. Reports newly unblocked tasks.

### graph_connect
Add or remove dependency and relationship edges. Cycle detection on depends_on.

### graph_query
Search and filter nodes by state, properties, text, ancestry, actionability.

### graph_restructure
Move, merge, or drop nodes. For replanning.

### graph_history
Read the audit trail for a node.

## Token Efficiency

Graph is designed to minimize token overhead. Every response is compact JSON — no UI metadata, no rich objects, no avatar URLs.

| Operation | Request | Response | Round trips |
|---|---|---|---|
| Open project + get summary | ~30 tokens | ~80 tokens | 1 |
| Plan 10 tasks with dependencies | ~300 tokens | ~80 tokens | 1 |
| Get next actionable task (with context) | ~30 tokens | ~200 tokens | 1 |
| Update + resolve a task | ~80 tokens | ~40 tokens | 1 |
| **Full claim-work-resolve cycle** | | **~500 tokens** | **3 calls** |

For comparison, the same workflow through a traditional tracker's MCP integration:

| Operation | Typical tokens | Round trips |
|---|---|---|
| List issues | ~1500 tokens | 1 |
| Get issue details | ~800 tokens | 1 |
| Get issue comments | ~600 tokens | 1 |
| Update issue state | ~400 tokens | 1 |
| Add comment | ~400 tokens | 1 |
| Get updated issue | ~800 tokens | 1 |
| **Same workflow** | **~4500 tokens** | **6 calls** |

**~90% token reduction, ~50% fewer round trips.**

Real-world validation: graph was used to plan and track its own development. An agent resuming work in a new session called `graph_open` + `graph_query` and got full project status (18 tasks, dependencies, what's blocked, what's actionable) in ~280 tokens total.

## Design

- **`resolved` boolean** is the only field the engine interprets. Drives dependency computation. `state` is freeform for agent semantics.
- **Evidence model** — hints, notes, commits, test results are all evidence entries with a `type` field. One mechanism.
- **Linked context** — nodes store pointers to files/commits/docs, not content blobs.
- **Local-first** — SQLite, no cloud dependency, your data stays on your machine.

## License

MIT
