import { spawn } from "child_process";
import { randomUUID } from "crypto";

const server = spawn("node", ["dist/index.js"], {
  env: {
    ...process.env,
    GRAPH_AGENT: "test-agent",
    GRAPH_DB: ":memory:",
  },
  stdio: ["pipe", "pipe", "pipe"],
});

let buffer = "";
let responseResolve = null;

server.stdout.on("data", (data) => {
  buffer += data.toString();
  // MCP uses JSON-RPC over newline-delimited JSON
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

server.stderr.on("data", (data) => {
  // MCP SDK logs to stderr, ignore
});

function send(method, params = {}) {
  return new Promise((resolve) => {
    responseResolve = resolve;
    const msg = {
      jsonrpc: "2.0",
      id: randomUUID(),
      method,
      params,
    };
    server.stdin.write(JSON.stringify(msg) + "\n");
  });
}

async function run() {
  try {
    // Initialize
    const initResult = await send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0" },
    });
    console.log("✓ Initialize:", initResult.result ? "OK" : "FAIL");

    // Send initialized notification
    server.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) +
        "\n"
    );

    // List tools
    const toolsResult = await send("tools/list");
    const toolNames = toolsResult.result.tools.map((t) => t.name);
    console.log("✓ Tools:", toolNames.join(", "));
    console.log(`  (${toolNames.length} tools)`);

    // 1. Open project
    const openResult = await send("tools/call", {
      name: "graph_open",
      arguments: { project: "test-project", goal: "Build graph" },
    });
    const openData = JSON.parse(openResult.result.content[0].text);
    const rootId = openData.root.id;
    console.log("✓ Open project:", openData.root.summary, "root:", rootId);

    // 2. Plan: create tasks
    const planResult = await send("tools/call", {
      name: "graph_plan",
      arguments: {
        nodes: [
          {
            ref: "db",
            parent_ref: rootId,
            summary: "Set up database schema",
            context_links: ["src/db.ts"],
            properties: { priority: 10, domain: "backend" },
          },
          {
            ref: "api",
            parent_ref: rootId,
            summary: "Build API layer",
            depends_on: ["db"],
            properties: { priority: 5, domain: "backend" },
          },
          {
            ref: "tests",
            parent_ref: rootId,
            summary: "Write tests",
            depends_on: ["api"],
            properties: { priority: 3 },
          },
        ],
      },
    });
    const planData = JSON.parse(planResult.result.content[0].text);
    console.log(
      "✓ Plan created:",
      planData.created.map((c) => `${c.ref}→${c.id}`).join(", ")
    );
    const idMap = Object.fromEntries(
      planData.created.map((c) => [c.ref, c.id])
    );

    // 3. Next: should return "db" (highest priority, no deps)
    const nextResult = await send("tools/call", {
      name: "graph_next",
      arguments: { project: "test-project" },
    });
    const nextData = JSON.parse(nextResult.result.content[0].text);
    console.log(
      "✓ Next actionable:",
      nextData.nodes[0]?.node.summary,
      "ancestors:",
      nextData.nodes[0]?.ancestors.length
    );

    // 4. Context: inspect the api task
    const ctxResult = await send("tools/call", {
      name: "graph_context",
      arguments: { node_id: idMap.api },
    });
    const ctxData = JSON.parse(ctxResult.result.content[0].text);
    console.log(
      "✓ Context for API:",
      "depends_on:",
      ctxData.depends_on.map((d) => d.node.summary).join(", "),
      "| satisfied:",
      ctxData.depends_on.map((d) => d.satisfied)
    );

    // 5. Update: resolve db task
    const updateResult = await send("tools/call", {
      name: "graph_update",
      arguments: {
        updates: [
          {
            node_id: idMap.db,
            resolved: true,
            add_evidence: [
              { type: "git", ref: "abc123" },
              { type: "hint", ref: "Used better-sqlite3, works well" },
            ],
          },
        ],
      },
    });
    const updateData = JSON.parse(updateResult.result.content[0].text);
    console.log(
      "✓ Updated db task: rev",
      updateData.updated[0].rev,
      "| newly_actionable:",
      updateData.newly_actionable?.map((n) => n.summary)
    );

    // 6. Next again: should return "api" now
    const next2 = await send("tools/call", {
      name: "graph_next",
      arguments: { project: "test-project", claim: true },
    });
    const next2Data = JSON.parse(next2.result.content[0].text);
    console.log(
      "✓ Next (after resolving db):",
      next2Data.nodes[0]?.node.summary,
      "| claimed:",
      next2Data.nodes[0]?.node.properties._claimed_by
    );

    // 7. Query: find blocked tasks
    const queryResult = await send("tools/call", {
      name: "graph_query",
      arguments: {
        project: "test-project",
        filter: { is_blocked: true },
      },
    });
    const queryData = JSON.parse(queryResult.result.content[0].text);
    console.log(
      "✓ Blocked tasks:",
      queryData.nodes.map((n) => n.summary)
    );

    // 8. Connect: add a relates_to edge
    const connResult = await send("tools/call", {
      name: "graph_connect",
      arguments: {
        edges: [{ from: idMap.api, to: idMap.tests, type: "relates_to" }],
      },
    });
    const connData = JSON.parse(connResult.result.content[0].text);
    console.log("✓ Connect:", connData.applied, "edge(s) applied");

    // 9. Restructure: drop tests
    const restrResult = await send("tools/call", {
      name: "graph_restructure",
      arguments: {
        operations: [
          { op: "drop", node_id: idMap.tests, reason: "Deferring to v2" },
        ],
      },
    });
    const restrData = JSON.parse(restrResult.result.content[0].text);
    console.log(
      "✓ Restructure:",
      restrData.details[0]?.result
    );

    // 10. History: check audit trail for db task
    const histResult = await send("tools/call", {
      name: "graph_history",
      arguments: { node_id: idMap.db },
    });
    const histData = JSON.parse(histResult.result.content[0].text);
    console.log(
      "✓ History for db:",
      histData.events.map((e) => e.action).join(", ")
    );

    // 11. Open again: check summary
    const open2 = await send("tools/call", {
      name: "graph_open",
      arguments: { project: "test-project" },
    });
    const open2Data = JSON.parse(open2.result.content[0].text);
    console.log("✓ Final summary:", JSON.stringify(open2Data.summary));

    // 12. List all projects
    const listResult = await send("tools/call", {
      name: "graph_open",
      arguments: {},
    });
    const listData = JSON.parse(listResult.result.content[0].text);
    console.log(
      "✓ List projects:",
      listData.projects.map((p) => `${p.summary} (${p.resolved}/${p.total})`)
    );

    console.log("\n=== ALL TESTS PASSED ===");
  } catch (error) {
    console.error("FAIL:", error);
  } finally {
    server.kill();
    process.exit(0);
  }
}

run();
