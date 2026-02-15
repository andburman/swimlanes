import { spawn } from "child_process";
import { randomUUID } from "crypto";

const server = spawn("node", ["dist/index.js"], {
  env: { ...process.env, GRAPH_AGENT: "claude-code", GRAPH_DB: "./graph.db" },
  stdio: ["pipe", "pipe", "pipe"],
});

let buffer = "", resolve;
server.stdout.on("data", (d) => {
  buffer += d;
  const lines = buffer.split("\n");
  buffer = lines.pop();
  for (const l of lines) {
    if (l.trim()) try { const m = JSON.parse(l); if (resolve) { resolve(m); resolve = null; } } catch {}
  }
});

const send = (m, p = {}) => new Promise((r) => { resolve = r; server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method: m, params: p }) + "\n"); });
const call = async (t, a = {}) => { const r = await send("tools/call", { name: t, arguments: a }); return JSON.parse(r.result.content[0].text); };

await send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "enrich", version: "1.0" } });
server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

// Evidence to add per node
const evidence = {
  // --- Hardening ---
  "K4bWZtW1fIrjiRpaGf_np": { // input validation
    evidence: [
      { type: "git", ref: "42058b6 — Added requireString, requireArray, optionalString, optionalNumber, optionalBoolean validators" },
      { type: "note", ref: "All 9 tool handlers validate required fields, types, and constraints before processing" },
    ],
    context_links: ["src/validate.ts"],
  },
  "thi_Vp2vHr314O2FIIUjX": { // error messages
    evidence: [
      { type: "git", ref: "42058b6 — Added ValidationError and EngineError classes with structured error codes" },
      { type: "note", ref: "MCP server returns {error, code} objects. Codes: validation_error, node_not_found, cycle_detected, duplicate_edge" },
    ],
    context_links: ["src/validate.ts", "src/server.ts"],
  },
  "MheCqssGNg-Qyl6hfe_TP": { // query performance (original)
    evidence: [
      { type: "git", ref: "e7951dd — Replaced per-node parent-chain walking with batch recursive CTE for depth computation" },
      { type: "note", ref: "Initial fix: computeDepths() in query.ts uses single recursive CTE. Later superseded by cached depth column in abd9721" },
    ],
    context_links: ["src/tools/query.ts", "src/tools/next.ts"],
  },
  "gBlpi-PBjzz2Llr4NkfAf": { // hardening parent
    evidence: [
      { type: "note", ref: "All 3 children resolved: input validation, error messages, query performance" },
    ],
  },

  // --- Distribution ---
  "d1KRnzNoX4mk_2Qd5RGsi": { // .gitignore
    evidence: [
      { type: "git", ref: "e7951dd — .gitignore covers dist/, node_modules/, *.db, .env" },
    ],
    context_links: [".gitignore"],
  },
  "9GuZjHuQy-tFbP2f4qlCM": { // npx support
    evidence: [
      { type: "git", ref: "42058b6 — Verified shebang in index.ts, bin field in package.json, files field for dist/" },
      { type: "note", ref: "package.json has bin.graph pointing to dist/index.js. tsup config adds shebang banner." },
    ],
    context_links: ["package.json", "tsup.config.ts"],
  },
  "LUdt8odUZODsxAy6f2fve": { // README
    evidence: [
      { type: "git", ref: "42058b6 — Initial README with install, configure, tool reference" },
      { type: "git", ref: "cc9d753 — Added token efficiency metrics table comparing graph vs traditional tracker" },
      { type: "git", ref: "429124b — Fixed GitHub URL to github.com/andburman/graph" },
      { type: "note", ref: "README includes: what/why, install, MCP config example, 9 tool descriptions, token efficiency comparison, design principles" },
    ],
    context_links: ["README.md"],
  },
  "7muyel7EI05ASGh9BXinb": { // distribution parent
    evidence: [
      { type: "note", ref: "All 3 children resolved: .gitignore, npx support, README" },
    ],
  },

  // --- Testing ---
  "HLTbjcVTxmdhvxpjtssJC": { // unit tests
    evidence: [
      { type: "git", ref: "42058b6 — 18 unit tests in test/core.test.ts" },
      { type: "note", ref: "Covers: node CRUD, parent-child, ancestors, project summary, property merge/delete, edge CRUD, cycle detection (direct + transitive), duplicate edges, newly actionable, event logging, pagination" },
    ],
    context_links: ["test/core.test.ts"],
  },
  "fppqYvqNoa9Aw8kDqQxIS": { // integration tests
    evidence: [
      { type: "git", ref: "42058b6 — 20 integration tests in test/tools.test.ts" },
      { type: "git", ref: "70e4682 — Added scale tests (100/500/1000 nodes) and diamond dependency tests (9 tests)" },
      { type: "note", ref: "Tools tests cover all 9 handlers + full workflow. Scale tests verify sub-3ms ops at 1000 nodes. Diamond tests verify fan-in, fan-out, double diamond, wide fan-in (20 deps)." },
    ],
    context_links: ["test/tools.test.ts", "test/scale.test.ts", "test/diamond.test.ts"],
  },
  "NKebdTtABX9ggnL5rpSIV": { // testing parent
    evidence: [
      { type: "note", ref: "51 tests total across 4 test files, all passing" },
    ],
  },

  // --- OSS Prep ---
  "Ropu6CpsDvGd6K4LeSU99": { // LICENSE
    evidence: [
      { type: "git", ref: "42058b6 — MIT LICENSE file added" },
    ],
    context_links: ["LICENSE"],
  },
  "VQ5-b4DeHbLuoo_6HnkaE": { // git init
    evidence: [
      { type: "git", ref: "e7951dd — Initial commit with full project structure" },
      { type: "note", ref: "Pushed to github.com/andburman/graph. Main branch, 7 commits." },
    ],
  },
  "nL8MOgkhBf5QTtV7dtspY": { // oss prep parent
    evidence: [
      { type: "note", ref: "All children resolved: LICENSE, git init. Repo live at github.com/andburman/graph" },
    ],
  },

  // --- Dogfood ---
  "K5ejNLlqv7g-7e6vxG61t": { // dogfood parent
    evidence: [
      { type: "git", ref: "46d7716 — Created dogfood.mjs and sl.mjs CLI helpers" },
      { type: "note", ref: "graph-v0 project tracks its own development. 23 nodes created, dependencies managed, mid-flight replanning validated (added perf tasks after initial plan)." },
    ],
    context_links: ["dogfood.mjs", "sl.mjs"],
  },

  // --- Performance ---
  "yBBVr4wcgVfWA_w8U8hQo": { // cache depth
    evidence: [
      { type: "git", ref: "abd9721 — Added depth INTEGER column to nodes table" },
      { type: "note", ref: "Schema migration auto-detects missing column, adds it, backfills via recursive CTE. Depth set on createNode (parent.depth+1), maintained on move/merge in restructure.ts. Eliminates recursive CTE from query.ts and next.ts." },
    ],
    context_links: ["src/db.ts", "src/nodes.ts", "src/types.ts"],
  },
  "uRocbNC_bArUXGr908Qbk": { // scope findNewlyActionable
    evidence: [
      { type: "git", ref: "abd9721 — findNewlyActionable now accepts optional resolvedNodeIds[]" },
      { type: "note", ref: "Targeted mode: only checks nodes with depends_on edges to resolved IDs + children of resolved IDs. Falls back to project-wide scan when no IDs given. Changed update.ts to pass resolved IDs." },
    ],
    context_links: ["src/edges.ts", "src/tools/update.ts"],
  },
  "md48WyMYFlOf4KP99vmtv": { // SQL ranking
    evidence: [
      { type: "git", ref: "abd9721 — Replaced in-memory sort with SQL ORDER BY + LIMIT" },
      { type: "note", ref: "ORDER BY COALESCE(CAST(json_extract(properties, '$.priority') AS REAL), 0) DESC, depth DESC, updated_at ASC LIMIT ?. Never loads more than N rows. Depends on cached depth column." },
    ],
    context_links: ["src/tools/next.ts"],
  },
  "tfMDHhmJSXd5TPgwD2ZC6": { // CTE ancestor filter
    evidence: [
      { type: "git", ref: "abd9721 — Replaced JS BFS getDescendantIds with recursive CTE" },
      { type: "note", ref: "WITH RECURSIVE descendants(id) AS (SELECT id FROM nodes WHERE parent = ? UNION ALL SELECT n.id FROM nodes n JOIN descendants d ON n.parent = d.id). Single SQL call instead of iterative traversal." },
    ],
    context_links: ["src/tools/query.ts"],
  },
  "OQwGvGiwKyVW_cKSps7BU": { // perf parent
    evidence: [
      { type: "git", ref: "abd9721 — All 4 perf optimizations in one commit" },
      { type: "git", ref: "70e4682 — Scale tests validate sub-3ms at 1000 nodes" },
      { type: "note", ref: "graph_next at 1000 nodes: 2.6ms. Full claim→resolve cycle: 2.3ms. All 4 children resolved." },
    ],
  },
};

let updated = 0;
for (const [nodeId, data] of Object.entries(evidence)) {
  const update = { node_id: nodeId };
  if (data.evidence) update.add_evidence = data.evidence;
  if (data.context_links) update.add_context_links = data.context_links;

  const result = await call("graph_update", { updates: [update] });
  console.log(`Updated ${nodeId} (rev ${result.updated[0].rev}): +${data.evidence?.length ?? 0} evidence, +${data.context_links?.length ?? 0} links`);
  updated++;
}

console.log(`\nEnriched ${updated} nodes with evidence.`);

server.kill();
process.exit(0);
