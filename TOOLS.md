# Graph — MCP Tool Surface v2

## Data Model

```typescript
interface Node {
  id: string;
  rev: number;                     // increments on every mutation
  parent?: string;                 // parent node ID
  summary: string;
  resolved: boolean;               // engine uses this for dependency computation
  state?: any;                     // agent-defined, no constraints — engine ignores this
  properties: Record<string, any>; // freeform key-value
  context_links: string[];         // pointers to files, commits, URLs, docs
  evidence: Evidence[];
  created_at: string;
  updated_at: string;
  created_by: string;              // agent identity, set from config
}

interface Evidence {
  type: string;       // "git", "test", "note", "hint", "file", or any custom type
  ref: string;        // the content — a SHA, a path, a message, a URL
  agent: string;      // who added it
  timestamp: string;
}

interface Edge {
  from: string;
  to: string;
  type: string;       // "depends_on", "relates_to", or any custom type
}
```

**Design notes:**
- `resolved` is the only field the engine interprets. It drives dependency computation and readiness ranking. Everything else is agent-defined semantics.
- `state` exists for agents to track their own lifecycle concepts. The engine stores it, returns it, never acts on it.
- `evidence` covers both outputs (commits, test results) and advice (hints for future sessions). Distinguish by `type`.
- Agent identity is set once in server config and attached to all writes automatically.

---

## Tools

### 1. graph_open

Open an existing project or create a new one. Called with no arguments, returns all projects.

```typescript
input: {
  project?: string,              // omit to list all projects
  goal?: string,                 // used on creation only
}

// When project is omitted:
returns: {
  projects: {
    id: string,
    summary: string,
    total: number,
    resolved: number,
    unresolved: number,
    updated_at: string,
  }[]
}

// When project is provided (existing or new):
returns: {
  root: Node,
  summary: {
    total: number,
    resolved: number,
    unresolved: number,
    blocked: number,              // unresolved with unresolved dependencies
    actionable: number,           // unresolved leaves with all deps resolved
  }
}
```

Lean. Counts only. Agent calls `graph_next` for work, `graph_query` to explore.

---

### 2. graph_plan

Batch create nodes with relationships. The decomposition operation.

```typescript
input: {
  nodes: {
    ref: string,                  // temp ID for intra-batch references
    parent_ref?: string,          // ref of another node in this batch, OR existing node ID
    summary: string,
    context_links?: string[],
    depends_on?: string[],        // refs within batch OR existing node IDs
    properties?: Record<string, any>,
  }[]
}

returns: {
  created: {
    ref: string,                  // the temp ref from input
    id: string,                   // the real assigned ID
  }[]
}
```

**Rules:**
- All nodes in a batch are created atomically — all succeed or all fail.
- `parent_ref` can reference a `ref` from another node in the same batch or an existing node ID in the database.
- `depends_on` follows the same convention.
- Cycle detection runs on dependency edges. Cycles are rejected with an error listing the cycle path.
- Nodes are created with `resolved: false` by default.

---

### 3. graph_next

Get the next actionable node. Server-side ranking.

```typescript
input: {
  project: string,
  scope?: string,                 // node ID — only return actionable descendants of this node
  filter?: Record<string, any>,   // match against node properties
  count?: number,                 // return top N, default 1
  claim?: boolean,                // if true, mark returned node(s) with agent identity
}

returns: {
  nodes: {
    node: Node,
    ancestors: {                  // root → parent chain, for scope
      id: string,
      summary: string,
    }[],
    context_links: {              // separated by source, not merged
      self: string[],
      inherited: { node_id: string, links: string[] }[],
    },
    resolved_deps: {              // what was completed that unblocked this
      id: string,
      summary: string,
      evidence: Evidence[],
    }[],
  }[]
}
```

**Ranking logic:**
A node is "actionable" when: `resolved: false` AND is a leaf (no unresolved children) AND all `depends_on` targets have `resolved: true`.

Among actionable nodes, rank by:
1. Agent-set `properties.priority` (if present, higher first)
2. Depth in tree (deeper = more specific = prefer)
3. Least recently updated (avoid starvation)

**Claim behavior:**
When `claim: true`, the returned node gets `properties._claimed_by` set to the agent identity and `properties._claimed_at` set to current timestamp. `graph_next` skips nodes claimed by a different agent within a configurable TTL (default 1 hour). Stale claims are ignored. This is soft locking — no fencing tokens, no hard leases. Sufficient for v0.

---

### 4. graph_context

Deep-read a node and its neighborhood.

```typescript
input: {
  node_id: string,
  depth?: number,                 // levels of children to return, default 2
}

returns: {
  node: Node,
  ancestors: {
    id: string,
    summary: string,
    resolved: boolean,
  }[],
  children: NodeTree,             // nested to requested depth
  depends_on: {
    node: Node,
    satisfied: boolean,           // true if target.resolved === true
  }[],
  depended_by: {
    node: Node,
    satisfied: boolean,
  }[],
}
```

```typescript
// NodeTree is recursive to the requested depth, then truncated to summaries
interface NodeTree {
  id: string,
  summary: string,
  resolved: boolean,
  state?: any,
  children?: NodeTree[],          // present up to depth limit
  child_count?: number,           // present when children are truncated
}
```

---

### 5. graph_update

Modify one or more nodes.

```typescript
input: {
  updates: {
    node_id: string,
    resolved?: boolean,
    state?: any,
    summary?: string,
    properties?: Record<string, any>,   // merged into existing, null value deletes key
    add_context_links?: string[],
    remove_context_links?: string[],
    add_evidence?: {
      type: string,
      ref: string,
    }[],
  }[]
}

returns: {
  updated: {
    node_id: string,
    rev: number,
  }[]
}
```

**Rules:**
- `properties` is merged, not replaced. `{ "priority": null }` deletes the key.
- `add_evidence` entries get `agent` and `timestamp` set automatically.
- When a node is set to `resolved: true`, the engine checks if this unblocks any dependents and includes them in the response:

```typescript
returns: {
  updated: { node_id: string, rev: number }[],
  newly_actionable?: {            // nodes that became actionable because of this update
    id: string,
    summary: string,
  }[],
}
```

This is important — the agent learns immediately what work it just unblocked, without a separate query.

---

### 6. graph_connect

Add or remove edges between nodes.

```typescript
input: {
  edges: {
    from: string,
    to: string,
    type: string,                 // "depends_on", "relates_to", or custom
    remove?: boolean,             // true to delete this edge
  }[]
}

returns: {
  applied: number,
  rejected?: {
    from: string,
    to: string,
    reason: string,               // "cycle_detected", "node_not_found", etc.
  }[]
}
```

**Rules:**
- `depends_on` edges get cycle detection. Other types do not.
- Parent-child relationships are NOT managed here. Use `graph_restructure` for reparenting.
- Adding a `depends_on` edge to an unresolved target immediately makes the source node blocked (if it wasn't already).

---

### 7. graph_query

Search and filter nodes.

```typescript
input: {
  project: string,
  filter?: {
    resolved?: boolean,
    properties?: Record<string, any>,  // match on property values
    text?: string,                     // substring match on summary
    ancestor?: string,                 // all descendants of this node
    has_evidence_type?: string,        // nodes with evidence of this type
    is_leaf?: boolean,
    is_actionable?: boolean,           // unresolved leaf, all deps resolved
    is_blocked?: boolean,              // unresolved, has unresolved dependency
    claimed_by?: string | null,        // filter by claim state, null = unclaimed
  },
  sort?: "readiness" | "depth" | "recent" | "created",
  limit?: number,                      // default 20, max 100
  cursor?: string,                     // opaque pagination cursor
}

returns: {
  nodes: {
    id: string,
    summary: string,
    resolved: boolean,
    state?: any,
    parent?: string,
    depth: number,
    properties: Record<string, any>,
  }[],
  total: number,
  next_cursor?: string,                // present if more results exist
}
```

---

### 8. graph_restructure

Modify graph structure. For replanning.

```typescript
input: {
  operations: ({
    op: "move",
    node_id: string,
    new_parent: string,
  } | {
    op: "merge",
    source: string,               // absorbed into target, then deleted
    target: string,               // survives, gets source's children + evidence
  } | {
    op: "drop",
    node_id: string,              // marks node + entire subtree as resolved
    reason: string,               // stored as evidence with type "dropped"
  })[]
}

returns: {
  applied: number,
  details: {
    op: string,
    node_id: string,
    result: string,
  }[],
  newly_actionable?: {
    id: string,
    summary: string,
  }[],
}
```

**Rules:**
- `move`: Validates no cycles in parent chain. Preserves all edges and children.
- `merge`: Source's children become target's children. Source's evidence is appended to target's. Source's dependency edges are transferred to target. Source is deleted.
- `drop`: Sets `resolved: true` on the node and all descendants. Adds evidence `{ type: "dropped", ref: reason }`. This may unblock other nodes — reported in `newly_actionable`.

---

### 9. graph_history

Read the audit trail for a node.

```typescript
input: {
  node_id: string,
  limit?: number,                 // default 20
  cursor?: string,
}

returns: {
  events: {
    timestamp: string,
    agent: string,
    action: string,               // "created", "updated", "resolved", "moved", "merged", "dropped"
    changes: {
      field: string,
      before: any,
      after: any,
    }[],
  }[],
  next_cursor?: string,
}
```

**Why this matters:** An agent in session 7 looks at a node and wonders "why was this dropped?" or "who changed the summary?" Without history, it has to guess. With history, it can reason about past decisions.

---

## Configuration

```yaml
# graph.config.yaml
agent_identity: "claude-code-v1"    # attached to all writes
db_path: "./graph.db"           # SQLite file location
claim_ttl_minutes: 60               # soft claim expiry
```

## Token Budget Estimates

Measured against real Claude Code sessions (swimlanes-v0, 30 nodes). Estimate = ~chars/4.

| Operation | Typical request | Typical response | Notes |
|---|---|---|---|
| graph_open (with project) | ~30 tokens | ~100 tokens | Includes full root node |
| graph_plan (4 nodes) | ~160 tokens | ~55 tokens | Scales ~40 tokens/node |
| graph_next | ~30 tokens | ~200-300 tokens | Higher with rich evidence on resolved deps |
| graph_context | ~20 tokens | ~220 tokens (depth 2) | Varies with subtree size |
| graph_update (1 node) | ~80 tokens | ~40 tokens | |
| graph_connect (1 edge) | ~40 tokens | ~20 tokens | |
| graph_query (3 results) | ~60 tokens | ~130 tokens | Scales ~45 tokens/node |
| graph_restructure (1 op) | ~50 tokens | ~40 tokens | |
| graph_history | ~20 tokens | ~200 tokens | |
| graph_onboard | ~20 tokens | ~400-600 tokens | Single-call orientation for new agents |

Full claim-work-resolve cycle: ~3 calls, ~450 tokens total. Compare to Linear MCP: ~6 calls, ~5000+ tokens.
