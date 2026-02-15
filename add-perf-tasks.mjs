import { spawn } from "child_process";
import { randomUUID } from "crypto";

const server = spawn("node", ["dist/index.js"], {
  env: { ...process.env, GRAPH_AGENT: "claude-code", GRAPH_DB: "./graph.db" },
  stdio: ["pipe", "pipe", "pipe"],
});

let buffer = "";
let responseResolve = null;
server.stdout.on("data", (data) => {
  buffer += data.toString();
  const lines = buffer.split("\n");
  buffer = lines.pop();
  for (const line of lines) {
    if (line.trim()) {
      try { const msg = JSON.parse(line); if (responseResolve) { responseResolve(msg); responseResolve = null; } } catch {}
    }
  }
});

async function send(method, params = {}) {
  return new Promise((resolve) => {
    responseResolve = resolve;
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params }) + "\n");
  });
}

async function call(toolName, args = {}) {
  const res = await send("tools/call", { name: toolName, arguments: args });
  if (res.result.isError) { console.error("ERROR:", res.result.content[0].text); return null; }
  return JSON.parse(res.result.content[0].text);
}

// Init MCP
await send("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "add-perf", version: "1.0" },
});
server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

// Get existing project
const project = await call("graph_open", { project: "graph-v0" });
const rootId = project.root.id;
console.log("Project root:", rootId);
console.log("Current status:", JSON.stringify(project.summary));

// Add performance optimization tasks under a new parent
const plan = await call("graph_plan", {
  nodes: [
    {
      ref: "perf",
      parent_ref: rootId,
      summary: "Scale to 500+ nodes — performance optimizations",
      properties: { priority: 9 },
    },
    {
      ref: "cache-depth",
      parent_ref: "perf",
      summary: "Cache depth as column on nodes — eliminate recursive CTE from query/next",
      context_links: ["src/db.ts", "src/nodes.ts", "src/tools/query.ts", "src/tools/next.ts"],
      properties: { priority: 10, domain: "backend" },
    },
    {
      ref: "scope-actionable",
      parent_ref: "perf",
      summary: "Scope findNewlyActionable to direct dependents — O(n) to O(degree)",
      context_links: ["src/edges.ts", "src/tools/update.ts"],
      properties: { priority: 9, domain: "backend" },
    },
    {
      ref: "sql-ranking",
      parent_ref: "perf",
      summary: "Push graph_next ranking into SQL — never load more than N rows",
      context_links: ["src/tools/next.ts"],
      depends_on: ["cache-depth"],
      properties: { priority: 8, domain: "backend" },
    },
    {
      ref: "cte-ancestor",
      parent_ref: "perf",
      summary: "Replace JS BFS with recursive CTE for ancestor filter in query",
      context_links: ["src/tools/query.ts"],
      properties: { priority: 7, domain: "backend" },
    },
  ],
});

console.log("\nPerformance tasks added:");
for (const c of plan.created) {
  console.log(`  ${c.ref} → ${c.id}`);
}

// Check updated summary
const summary = await call("graph_open", { project: "graph-v0" });
console.log("\nUpdated project summary:", JSON.stringify(summary.summary, null, 2));

// Check what's now actionable
const next = await call("graph_next", { project: "graph-v0", count: 10 });
console.log("\nActionable tasks (ranked):");
for (const n of next.nodes) {
  console.log(`  [P${n.node.properties.priority ?? 0}] ${n.node.summary} (${n.node.id})`);
}

server.kill();
process.exit(0);
