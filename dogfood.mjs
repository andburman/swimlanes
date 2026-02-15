import { spawn } from "child_process";
import { randomUUID } from "crypto";

const server = spawn("node", ["dist/index.js"], {
  env: {
    ...process.env,
    GRAPH_AGENT: "claude-code",
    GRAPH_DB: "./graph.db",
  },
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
      try {
        const msg = JSON.parse(line);
        if (responseResolve) {
          responseResolve(msg);
          responseResolve = null;
        }
      } catch {}
    }
  }
});

async function send(method, params = {}) {
  return new Promise((resolve) => {
    responseResolve = resolve;
    server.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params }) + "\n"
    );
  });
}

async function call(toolName, args = {}) {
  const res = await send("tools/call", { name: toolName, arguments: args });
  return JSON.parse(res.result.content[0].text);
}

async function run() {
  // Init MCP
  await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "dogfood", version: "1.0" },
  });
  server.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n"
  );

  // === CREATE THE GRAPH PROJECT PLAN ===

  // 1. Open the project
  const project = await call("graph_open", {
    project: "graph-v0",
    goal: "Ship graph v0 — agent-native persistent task graph. MCP server, TypeScript, SQLite.",
  });
  const rootId = project.root.id;
  console.log("Project created:", project.root.summary);
  console.log("Root ID:", rootId);
  console.log();

  // 2. Plan the remaining work
  const plan = await call("graph_plan", {
    nodes: [
      // Hardening
      {
        ref: "hardening",
        parent_ref: rootId,
        summary: "Harden the engine for real-world use",
        properties: { priority: 10 },
      },
      {
        ref: "input-validation",
        parent_ref: "hardening",
        summary: "Add input validation to all tool handlers — validate required fields, types, string lengths",
        context_links: ["src/tools/", "src/server.ts"],
        properties: { priority: 10, domain: "backend" },
      },
      {
        ref: "error-messages",
        parent_ref: "hardening",
        summary: "Improve error messages — structured error codes, actionable suggestions",
        context_links: ["src/server.ts"],
        properties: { priority: 8, domain: "backend" },
      },
      {
        ref: "query-perf",
        parent_ref: "hardening",
        summary: "Optimize query performance — avoid N+1 depth computation, batch ancestor lookups",
        context_links: ["src/tools/query.ts", "src/tools/next.ts"],
        properties: { priority: 7, domain: "backend" },
      },

      // Distribution
      {
        ref: "distribution",
        parent_ref: rootId,
        summary: "Make graph easy to install and configure",
        properties: { priority: 8 },
      },
      {
        ref: "npx-support",
        parent_ref: "distribution",
        summary: "Make 'npx graph' work — ensure bin field, shebang, and package.json are correct",
        context_links: ["package.json", "tsup.config.ts"],
        properties: { priority: 9, domain: "infra" },
      },
      {
        ref: "readme",
        parent_ref: "distribution",
        summary: "Write README — what it is, how to install, MCP config example, tool reference",
        properties: { priority: 7, domain: "docs" },
      },
      {
        ref: "gitignore",
        parent_ref: "distribution",
        summary: "Add .gitignore — dist/, node_modules/, *.db",
        properties: { priority: 10, domain: "infra" },
      },

      // Testing
      {
        ref: "testing",
        parent_ref: rootId,
        summary: "Build confidence through testing",
        properties: { priority: 6 },
      },
      {
        ref: "unit-tests",
        parent_ref: "testing",
        summary: "Unit tests for core layer — nodes, edges (cycle detection), events",
        context_links: ["src/nodes.ts", "src/edges.ts", "src/events.ts"],
        depends_on: ["input-validation"],
        properties: { priority: 6, domain: "testing" },
      },
      {
        ref: "integration-tests",
        parent_ref: "testing",
        summary: "Integration tests for tool handlers — full workflows via MCP protocol",
        context_links: ["test-e2e.mjs"],
        depends_on: ["unit-tests"],
        properties: { priority: 5, domain: "testing" },
      },

      // Dogfood
      {
        ref: "dogfood",
        parent_ref: rootId,
        summary: "Use graph to build graph — validate with real agent workflows",
        depends_on: ["hardening"],
        properties: { priority: 9 },
      },
      {
        ref: "token-measurement",
        parent_ref: "dogfood",
        summary: "Measure actual token usage of each tool call in real Claude Code sessions. Compare to TOOLS.md estimates.",
        context_links: ["TOOLS.md"],
        depends_on: ["dogfood"],
        properties: { priority: 8, domain: "validation" },
      },
      {
        ref: "tool-surface-fixes",
        parent_ref: "dogfood",
        summary: "Fix tool surface issues discovered during dogfooding — adjust schemas, response shapes, ranking logic",
        depends_on: ["token-measurement"],
        properties: { priority: 8, domain: "backend" },
      },

      // Open source prep
      {
        ref: "oss-prep",
        parent_ref: rootId,
        summary: "Prepare for open source release",
        depends_on: ["distribution", "testing"],
        properties: { priority: 5 },
      },
      {
        ref: "license",
        parent_ref: "oss-prep",
        summary: "Add MIT LICENSE file",
        depends_on: ["oss-prep"],
        properties: { priority: 5, domain: "docs" },
      },
      {
        ref: "git-init",
        parent_ref: "oss-prep",
        summary: "Initialize git repo, create initial commit",
        depends_on: ["gitignore", "license"],
        properties: { priority: 5, domain: "infra" },
      },
    ],
  });

  console.log("Plan created:");
  for (const c of plan.created) {
    console.log(`  ${c.ref} → ${c.id}`);
  }
  console.log();

  // 3. Check what's actionable
  const next = await call("graph_next", {
    project: "graph-v0",
    count: 5,
  });
  console.log("Next actionable tasks (ranked):");
  for (const n of next.nodes) {
    const p = n.node.properties.priority ?? 0;
    console.log(`  [P${p}] ${n.node.summary}`);
    if (n.ancestors.length > 0) {
      console.log(`       under: ${n.ancestors.map((a) => a.summary).join(" → ")}`);
    }
  }
  console.log();

  // 4. Check what's blocked
  const blocked = await call("graph_query", {
    project: "graph-v0",
    filter: { is_blocked: true },
  });
  console.log(`Blocked tasks (${blocked.total}):`);
  for (const n of blocked.nodes) {
    console.log(`  ${n.summary}`);
  }
  console.log();

  // 5. Overall summary
  const summary = await call("graph_open", { project: "graph-v0" });
  console.log("Project summary:", JSON.stringify(summary.summary, null, 2));

  server.kill();
  process.exit(0);
}

run().catch((e) => {
  console.error(e);
  server.kill();
  process.exit(1);
});
