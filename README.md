# Graph

A task tracker built for AI agents, not humans.

Graph is an MCP server that gives agents persistent memory across sessions. They decompose work into dependency trees, claim tasks, record evidence of what they did, and hand off to the next agent automatically.

## Install

```bash
npx -y @graph-tl/graph init
```

Restart Claude Code. That's it.

## See it work

Tell your agent: "Use graph to plan building a REST API with auth and tests."

The agent will:
1. Create a project (`graph_open`)
2. Interview you about scope (`discovery`)
3. Decompose into a dependency tree (`graph_plan`)
4. Claim and work on tasks one by one (`graph_next` → work → `graph_update`)
5. When you start a new session, the next agent picks up exactly where the last one left off (`graph_onboard`)

No copy-pasting context. No re-explaining what was done. The graph carries it forward.

## Why

Issue trackers (Jira, Linear) are built for humans: columns, boards, sprints, UI. When agents talk to them via MCP, they waste tokens on metadata and need 6+ round trips for simple workflows.

Graph gives agents what they actually need:
- **Persistent across sessions** — an agent picks up exactly where the last one left off
- **Arbitrary nesting** — decompose work as deep as needed
- **Dependencies with cycle detection** — the engine knows what's blocked and what's ready
- **Server-side ranking** — one call to get the highest-priority actionable task
- **Evidence trail** — agents record decisions, commits, and test results so the next agent inherits that knowledge
- **~450 tokens** for a full claim-work-resolve cycle (vs ~5000+ with Linear MCP)

## How it works

```
1. graph_onboard     → "What's the state of this project?"
2. graph_next        → "What should I work on?" (claim it)
3.    ... do the work ...
4. graph_update      → "Done. Here's what I did." (resolve with evidence)
5.    → engine returns newly unblocked tasks
6. graph_next        → "What's next?"
```

When a new agent joins, `graph_onboard` returns everything it needs in one call: project goal, task tree, recent evidence, knowledge entries, what was recently resolved, and what's actionable now.

### Planning

The agent calls `graph_plan` to create a dependency tree:

```
Build REST API
├── Design
│   └── Write API spec
├── Implementation
│   ├── Auth module          (depends on: Write API spec)
│   ├── Routes               (depends on: Write API spec)
│   └── Database layer
└── Testing
    ├── Unit tests           (depends on: Auth, Routes, Database)
    └── Integration tests    (depends on: Unit tests)
```

`graph_next` immediately knows: "Write API spec" and "Database layer" are actionable. Everything else is blocked. When a task resolves, dependents unblock automatically.

### Agent handoff

Session 1 ends after completing 3 tasks. Session 2 starts:

```
→ graph_onboard("my-project")

← {
    goal: "Build REST API",
    hint: "2 actionable task(s) ready. 3 resolved recently.",
    summary: { total: 8, resolved: 3, actionable: 2 },
    recently_resolved: [
      { summary: "Auth module", agent: "claude-code", resolved_at: "..." },
    ],
    knowledge: [
      { key: "auth-decisions", content: "JWT with RS256, keys in /config" },
    ],
    actionable: [
      { summary: "Routes", priority: 8 },
      { summary: "Database layer", priority: 7 },
    ]
  }
```

The new agent knows what was built, what decisions were made, and what to do next.

### Code annotations

Agents annotate key changes with `// [sl:nodeId]`:

```typescript
// [sl:OZ0or-q5TserCEfWUeMVv] Require evidence when resolving
if (input.resolved === true && !node.resolved) {
  const hasExistingEvidence = node.evidence.length > 0;
  const hasNewEvidence = input.add_evidence && input.add_evidence.length > 0;
  if (!hasExistingEvidence && !hasNewEvidence) {
    throw new EngineError("evidence_required", ...);
  }
}
```

That node ID links to a task in the graph. Call `graph_context` or `graph_history` on it to see what the task was, why it was done, what files were touched, and who did it.

## Tools

| Tool | Purpose |
|---|---|
| **graph_onboard** | Single-call orientation: project summary, tree, evidence, knowledge, actionable tasks. Omit project to auto-select |
| **graph_open** | Open or create a project. No args = list all projects |
| **graph_plan** | Batch create tasks with dependencies. Atomic |
| **graph_next** | Get next actionable task, ranked by priority/depth/recency. Optional claim |
| **graph_tree** | Full project tree visualization with resolve status |
| **graph_context** | Deep-read a task: ancestors, children, dependency graph |
| **graph_update** | Resolve tasks, add evidence. Reports newly unblocked tasks. Auto-resolves parents when all children complete |
| **graph_connect** | Add/remove dependency edges with cycle detection |
| **graph_query** | Search and filter by state, properties, text, ancestry |
| **graph_restructure** | Move, merge, or drop tasks for replanning |
| **graph_history** | Audit trail: who changed what, when |
| **graph_knowledge_write** | Store persistent project knowledge (architecture decisions, conventions) |
| **graph_knowledge_read** | Read knowledge entries or list all |
| **graph_knowledge_search** | Search knowledge by substring |

## Configuration

Add to `.mcp.json` (or run `npx -y @graph-tl/graph init`):

```json
{
  "mcpServers": {
    "graph": {
      "command": "npx",
      "args": ["-y", "@graph-tl/graph"],
      "env": {
        "GRAPH_AGENT": "claude-code"
      }
    }
  }
}
```

Environment variables (all optional):

| Variable | Default | Description |
|---|---|---|
| `GRAPH_AGENT` | `default-agent` | Agent identity for audit trail |
| `GRAPH_DB` | `~/.graph/db/<hash>/graph.db` | Database path (per-project, outside your repo) |
| `GRAPH_CLAIM_TTL` | `60` | Soft claim expiry in minutes |
| `GRAPH_UPDATE_CHECK` | `0` | Set to `1` to check npm for newer versions on startup |

## Token efficiency

| Operation | Tokens | Round trips |
|---|---|---|
| Onboard to a 30-task project | ~500 | 1 |
| Plan 4 tasks with dependencies | ~220 | 1 |
| Get next actionable task | ~300 | 1 |
| Resolve + see what unblocked | ~120 | 1 |
| **Full claim-work-resolve cycle** | **~450** | **3** |

~90% fewer tokens and ~50% fewer round trips vs traditional tracker MCP integrations.

## Data & security

Graph is fully local. Your data never leaves your machine.

- **Single SQLite file** in `~/.graph/db/` — outside your repo, nothing to gitignore
- **No network calls** — stdio MCP server, no telemetry, no cloud sync
- **No secrets stored** — task summaries, evidence notes, and file path references only
- **You own your data** — back it up, delete it, move it between machines

## License

MIT — free and open source.
