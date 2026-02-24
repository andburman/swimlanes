# Graph

[![npm version](https://img.shields.io/npm/v/@graph-tl/graph)](https://www.npmjs.com/package/@graph-tl/graph)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![npm downloads](https://img.shields.io/npm/dm/@graph-tl/graph)](https://www.npmjs.com/package/@graph-tl/graph)

Graph gives agents session-to-session memory with actionable next steps.

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
- **Minimal overhead** — batched operations and structured responses keep token usage low

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

## State & evidence model

Graph tracks three complementary layers per task:

| Layer | Fields | Purpose |
|---|---|---|
| **Task state** | `resolved`, `blocked`, `state` | Drive dependency computation and actionability ranking |
| **Evidence** | `evidence[]` — type, ref, agent, timestamp | Immutable trail: commits, test results, decisions |
| **Repo pointers** | `context_links[]` — file paths, URLs | Bridge from DB task to actual code changes |

When a task resolves, high-quality evidence has three parts: a **git commit** (traceable artifact), a **note** (what was done and why), and **context_links** (which files changed). The engine measures this as a quality KPI and flags tasks with weak evidence.

**Continuity confidence** (0-100) scores how well the project supports agent handoff based on evidence coverage, staleness, knowledge gaps, and stale blockers. Returned in `graph_onboard` so the next agent knows whether to trust the existing state or re-verify.

The `state` field is agent-defined and engine-ignored — use it for your own lifecycle tracking (draft, review, etc.) without affecting dependency computation.

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
| **graph_resolve** | One-call resolve helper: auto-collects git commits and modified files as evidence |
| **graph_connect** | Add/remove dependency edges with cycle detection |
| **graph_query** | Search and filter by state, properties, text, ancestry |
| **graph_restructure** | Move, merge, or drop tasks for replanning |
| **graph_status** | Formatted project dashboard: progress, task tree, integrity, knowledge |
| **graph_history** | Audit trail: who changed what, when |
| **graph_retro** | Structured retrospective: gather resolved tasks, record categorized findings |
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
      "args": ["-y", "@graph-tl/graph@latest"],
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

## CLI

```bash
graph init           # Set up graph in the current project
graph update         # Clear npx cache and re-run init to get the latest version
graph ship           # Build, test, bump, commit, push, and create GitHub release
graph backup         # List, create, or restore database backups
graph ui             # Start the web UI
graph --version      # Print version
graph --help         # Print usage summary
```

### Updating

Graph checks npm for newer versions on every MCP server startup. When an update is available, agents see the notice at session start via `graph_onboard`. To update:

```bash
npx @graph-tl/graph update
```

This clears the npx cache, re-writes `.mcp.json` with `@latest` pinning, and updates the agent file. Restart Claude Code to load the new version.

## Token efficiency

Graph is designed to minimize agent overhead. Every operation is a single MCP call with structured, compact responses — no pagination, no field filtering, no extra round trips. Batched operations like `graph_plan` and `graph_update` let agents do more per call, and `graph_onboard` delivers full project context in one shot instead of requiring a sequence of queries.

## Data & security

Your data stays on your machine.

- **Single SQLite file** in `~/.graph/db/` — outside your repo, nothing to gitignore
- **Local-first** — stdio MCP server, no telemetry, no cloud sync. The only network activity is `npx` fetching the package
- **No secrets stored** — task summaries, evidence notes, and file path references only
- **You own your data** — back it up, delete it, move it between machines

## License

MIT — free and open source.
