# Graph

A task tracker built for AI agents, not humans.

Graph is an MCP server that lets agents plan, execute, and hand off work across sessions. It stores tasks as a dependency graph in SQLite — agents decompose work into subtrees, claim tasks, record what they did, and pass context to the next agent automatically.

Humans create projects and review results. Agents do everything in between.

## Why

Issue trackers (Jira, Linear) are built for humans: columns, boards, sprints, UI. When agents talk to them via MCP, they waste tokens on metadata and need 6+ round trips for simple workflows.

Graph gives agents what they actually need:
- **Persistent across sessions** — an agent picks up exactly where the last one left off
- **Arbitrary nesting** — decompose work as deep as needed
- **Dependencies with cycle detection** — the engine knows what's blocked and what's ready
- **Server-side ranking** — one call to get the highest-priority actionable task
- **Evidence trail** — agents record decisions, commits, and test results as they work, so the next agent inherits that knowledge
- **~450 tokens** for a full claim-work-resolve cycle (vs ~5000+ with Linear MCP)

## Use Cases

**Multi-session projects.** You tell Claude Code to build a feature. It plans the work into a graph, finishes 3 of 5 tasks, and hits the context limit. You start a new session — the agent calls `graph_onboard`, sees what was done, what's left, and picks up the next task with full context. No copy-pasting, no re-explaining.

**Agent handoff.** Agent 1 builds the backend. Agent 2 starts a fresh session to work on the frontend. It calls `graph_next` and gets the highest-priority unblocked task, along with evidence from the tasks it depends on — what was implemented, what decisions were made, what files were touched.

**Complex decomposition.** You say "build me a CLI tool with auth, a database layer, and tests." The agent breaks this into a task tree with dependencies — tests depend on implementation, implementation depends on design. The engine tracks what's blocked and what's ready so the agent always works on the right thing.

**Replanning mid-flight.** Halfway through a project, requirements change. The agent uses `graph_restructure` to drop irrelevant tasks, add new ones, and reparent subtrees. Dependencies recalculate automatically.

## How It Works

An agent's workflow with Graph looks like this:

```
1. graph_onboard     → "What's the state of this project?"
2. graph_next        → "What should I work on?" (claim it)
3.    ... do the work ...
4. graph_update      → "Done. Here's what I did." (resolve with evidence)
5.    → engine returns newly unblocked tasks
6. graph_next        → "What's next?"
```

When a new agent joins, `graph_onboard` returns everything it needs in one call: project status, task tree, recent evidence from completed work, all file references, and what's actionable now.

### Example: Planning a project

You tell the agent: "Build a REST API with authentication and tests."

The agent calls `graph_plan` to create this structure:

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

`graph_next` immediately knows: "Write API spec" and "Database layer" are actionable. Everything else is blocked. When "Write API spec" is resolved, "Auth module" and "Routes" unblock automatically.

### Example: Agent handoff between sessions

Session 1 ends after completing 3 tasks. Session 2 starts:

```
→ graph_onboard("my-project")

← {
    summary: { total: 8, resolved: 3, unresolved: 5, actionable: 2 },
    recent_evidence: [
      { task: "Auth module", type: "note", ref: "Used JWT with RS256, keys in /config" },
      { task: "Auth module", type: "git", ref: "a]1b2c3d — implement auth middleware" },
      ...
    ],
    context_links: ["src/auth.ts", "src/db.ts", "config/keys.json"],
    actionable: [
      { summary: "Routes", priority: 8 },
      { summary: "Database layer", priority: 7 },
    ]
  }
```

The new agent knows what was built, how, and what to do next — without reading the entire codebase or prior conversation.

### Code annotations: from static comments to traceable history

Code comments tell you *what* code does. Graph annotations tell you *why it exists, who wrote it, and what was considered*.

When agents work through Graph, they annotate key changes with `// [sl:nodeId]`:

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

That node ID links to a task in the graph. A future agent (or human) can call `graph_context` or `graph_history` on that ID and get:

- **What the task was** — "Enforce evidence on resolve"
- **Why it was done** — the evidence trail: design decisions, alternatives considered
- **What else changed** — context links to every file modified for that task
- **Who did it and when** — the full audit log

Comments are a snapshot. Graph turns your codebase into a traceable history of decisions.

## Install

Add to your Claude Code MCP config (`.mcp.json` in your project root):

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

That's it. No cloning, no building. npx handles everything.

### From source

```bash
git clone https://github.com/Graph-tl/graph.git
cd graph
npm install
npm run build
```

Then point your `.mcp.json` at the local build:

```json
{
  "mcpServers": {
    "graph": {
      "command": "node",
      "args": ["./graph/dist/index.js"],
      "env": {
        "GRAPH_AGENT": "claude-code"
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

| Tool | Purpose |
|---|---|
| **graph_onboard** | Single-call orientation for a new agent joining a project. Returns project summary, task tree, recent evidence, context links, and actionable tasks. |
| **graph_open** | Open or create a project. No args = list all projects. |
| **graph_plan** | Batch create tasks with parent-child and dependency relationships. Atomic. |
| **graph_next** | Get the next actionable task, ranked by priority/depth/recency. Optional scope to a subtree. Optional soft claim. |
| **graph_context** | Deep-read a task: ancestors, children tree, dependency graph. |
| **graph_update** | Resolve tasks, add evidence/context links. Reports newly unblocked tasks. |
| **graph_connect** | Add or remove dependency edges. Cycle detection on `depends_on`. |
| **graph_query** | Search and filter tasks by state, properties, text, ancestry, actionability. |
| **graph_restructure** | Move, merge, or drop tasks. For replanning. |
| **graph_history** | Audit trail for a task — who changed what, when. |

See [TOOLS.md](TOOLS.md) for full schemas and response shapes.

## Token Efficiency

Every response is compact JSON — no UI chrome, no avatar URLs, no pagination boilerplate. Measured against real Claude Code sessions:

| Operation | Tokens | Round trips |
|---|---|---|
| Onboard a new agent to a 30-task project | ~500 | 1 |
| Plan 4 tasks with dependencies | ~220 | 1 |
| Get next actionable task (with context) | ~300 | 1 |
| Resolve a task + see what unblocked | ~120 | 1 |
| **Full claim-work-resolve cycle** | **~450** | **3** |

The same workflow through a traditional tracker's MCP integration typically costs ~4500 tokens across 6 round trips. **~90% token reduction, ~50% fewer round trips.**

## Data & Security

Graph is fully local. Your data never leaves your machine.

- **Single SQLite file** — everything is stored in one `.db` file at the path you configure via `GRAPH_DB`. Default: `./graph.db` in the working directory.
- **No network calls** — Graph is a stdio MCP server. It reads and writes to disk. There is no telemetry, no cloud sync, no external API calls.
- **No secrets in the graph** — Graph stores task summaries, evidence notes, and file path references. It does not read file contents, access credentials, or store source code.
- **You control the data** — the SQLite file is yours. Back it up, delete it, move it between machines. There is no account, no server, no lock-in.
- **Gitignore it** — add `*.db` to your `.gitignore`. The graph contains project-specific planning data that doesn't belong in version control.

## Design

- **`resolved` boolean** is the only field the engine interprets. Drives dependency computation. `state` is freeform for agent semantics.
- **Evidence model** — hints, notes, commits, test results are all evidence entries with a `type` field. One mechanism.
- **Linked context** — nodes store pointers to files/commits/docs, not content blobs.

## License

MIT
