// Reusable graph CLI helper
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

// Init
await send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "sl", version: "1.0" } });
server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

const cmd = process.argv[2];
const arg = process.argv[3];

if (cmd === "next") {
  const r = await call("graph_next", { project: "graph-v0", count: parseInt(arg || "5") });
  for (const n of r.nodes) {
    console.log(`[P${n.node.properties.priority ?? 0}] ${n.node.summary}`);
    console.log(`     id: ${n.node.id}`);
  }
} else if (cmd === "resolve") {
  const r = await call("graph_update", { updates: [{ node_id: arg, resolved: true }] });
  console.log("Resolved. Rev:", r.updated[0].rev);
  if (r.newly_actionable?.length) console.log("Unblocked:", r.newly_actionable.map(n => n.summary).join(", "));
} else if (cmd === "summary") {
  const r = await call("graph_open", { project: "graph-v0" });
  console.log(JSON.stringify(r.summary, null, 2));
} else if (cmd === "blocked") {
  const r = await call("graph_query", { project: "graph-v0", filter: { is_blocked: true } });
  for (const n of r.nodes) console.log(`  ${n.summary} (${n.id})`);
} else {
  console.log("Usage: node sl.mjs [next|resolve <id>|summary|blocked]");
}

server.kill();
process.exit(0);
