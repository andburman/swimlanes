import { describe, it, expect, beforeEach } from "vitest";
import { initDb } from "../src/db.js";
import { handleOpen } from "../src/tools/open.js";
import { handlePlan } from "../src/tools/plan.js";
import { handleNext } from "../src/tools/next.js";
import { handleQuery } from "../src/tools/query.js";
import { handleUpdate } from "../src/tools/update.js";
import { handleContext } from "../src/tools/context.js";

const AGENT = "scale-test";

function time<T>(label: string, fn: () => T): { result: T; ms: number } {
  const start = performance.now();
  const result = fn();
  const ms = performance.now() - start;
  console.log(`  ${label}: ${ms.toFixed(1)}ms`);
  return { result, ms };
}

// Build a project with N nodes across realistic structure:
// - 10 workstreams (depth 1)
// - Each workstream has N/10 tasks (depth 2)
// - Every 5th task depends on the previous task (linear chains)
// - Cross-workstream dependencies every 20 tasks
function buildProject(name: string, nodeCount: number) {
  const { root } = handleOpen({ project: name, goal: `Scale test (${nodeCount} nodes)` }, AGENT) as any;

  const workstreamCount = 10;
  const tasksPerWorkstream = Math.floor((nodeCount - 1) / workstreamCount); // -1 for root

  for (let w = 0; w < workstreamCount; w++) {
    const nodes: any[] = [];

    // Workstream parent
    nodes.push({
      ref: `ws-${w}`,
      parent_ref: root.id,
      summary: `Workstream ${w}`,
      properties: { priority: workstreamCount - w },
    });

    // Tasks under this workstream
    for (let t = 0; t < tasksPerWorkstream; t++) {
      const task: any = {
        ref: `ws-${w}-t-${t}`,
        parent_ref: `ws-${w}`,
        summary: `Task ${w}.${t} — ${randomSummary()}`,
        properties: { priority: Math.floor(Math.random() * 10), domain: `area-${t % 5}` },
        context_links: [`src/module-${w}/file-${t}.ts`],
      };

      // Linear dependency chain: every 5th task depends on the previous
      if (t > 0 && t % 5 === 0) {
        task.depends_on = [`ws-${w}-t-${t - 1}`];
      }

      nodes.push(task);
    }

    handlePlan({ nodes }, AGENT);
  }

  return root;
}

const summaries = [
  "Implement auth flow", "Add validation", "Write tests", "Refactor module",
  "Fix edge case", "Update schema", "Add logging", "Optimize query",
  "Handle errors", "Add caching", "Update docs", "Review design",
  "Add metrics", "Fix race condition", "Improve UX", "Add retry logic",
];

function randomSummary(): string {
  return summaries[Math.floor(Math.random() * summaries.length)];
}

describe("scale: 100 nodes", () => {
  beforeEach(() => initDb(":memory:"));

  it("builds and queries efficiently", () => {
    console.log("\n=== 100 nodes ===");

    const { ms: buildMs } = time("build 100 nodes", () => buildProject("scale-100", 100));
    expect(buildMs).toBeLessThan(2000);

    const { result: next, ms: nextMs } = time("swimlanes_next (top 5)", () =>
      handleNext({ project: "scale-100", count: 5 }, AGENT)
    );
    expect(next.nodes.length).toBeGreaterThan(0);
    expect(nextMs).toBeLessThan(100);

    const { result: query, ms: queryMs } = time("swimlanes_query (actionable)", () =>
      handleQuery({ project: "scale-100", filter: { is_actionable: true } })
    );
    expect(query.nodes.length).toBeGreaterThan(0);
    expect(queryMs).toBeLessThan(100);

    const { result: blocked, ms: blockedMs } = time("swimlanes_query (blocked)", () =>
      handleQuery({ project: "scale-100", filter: { is_blocked: true } })
    );
    expect(blockedMs).toBeLessThan(100);

    const { result: text, ms: textMs } = time("swimlanes_query (text search)", () =>
      handleQuery({ project: "scale-100", filter: { text: "auth" } })
    );
    expect(textMs).toBeLessThan(100);

    const { ms: openMs } = time("swimlanes_open (summary)", () =>
      handleOpen({ project: "scale-100" }, AGENT)
    );
    expect(openMs).toBeLessThan(100);
  });
});

describe("scale: 500 nodes", () => {
  beforeEach(() => initDb(":memory:"));

  it("builds and queries efficiently", () => {
    console.log("\n=== 500 nodes ===");

    const { ms: buildMs } = time("build 500 nodes", () => buildProject("scale-500", 500));
    expect(buildMs).toBeLessThan(5000);

    const { result: next, ms: nextMs } = time("swimlanes_next (top 5)", () =>
      handleNext({ project: "scale-500", count: 5 }, AGENT)
    );
    expect(next.nodes.length).toBeGreaterThan(0);
    expect(nextMs).toBeLessThan(200);

    const { result: query, ms: queryMs } = time("swimlanes_query (actionable)", () =>
      handleQuery({ project: "scale-500", filter: { is_actionable: true } })
    );
    expect(query.nodes.length).toBeGreaterThan(0);
    expect(queryMs).toBeLessThan(200);

    const { ms: blockedMs } = time("swimlanes_query (blocked)", () =>
      handleQuery({ project: "scale-500", filter: { is_blocked: true } })
    );
    expect(blockedMs).toBeLessThan(200);

    const { ms: textMs } = time("swimlanes_query (text search)", () =>
      handleQuery({ project: "scale-500", filter: { text: "auth" } })
    );
    expect(textMs).toBeLessThan(200);

    const { ms: propMs } = time("swimlanes_query (property filter)", () =>
      handleQuery({ project: "scale-500", filter: { properties: { domain: "area-2" } } })
    );
    expect(propMs).toBeLessThan(200);

    const { ms: openMs } = time("swimlanes_open (summary)", () =>
      handleOpen({ project: "scale-500" }, AGENT)
    );
    expect(openMs).toBeLessThan(200);
  });

  it("resolve + unblock cycle is fast", () => {
    console.log("\n=== 500 nodes: resolve cycle ===");
    buildProject("scale-500-resolve", 500);

    // Get next actionable
    const { result: next, ms: nextMs } = time("swimlanes_next (claim)", () =>
      handleNext({ project: "scale-500-resolve", claim: true }, AGENT)
    );
    expect(nextMs).toBeLessThan(200);
    expect(next.nodes.length).toBe(1);

    const nodeId = next.nodes[0].node.id;

    // Resolve it
    const { result: update, ms: updateMs } = time("swimlanes_update (resolve)", () =>
      handleUpdate({ updates: [{ node_id: nodeId, resolved: true, add_evidence: [{ type: "test", ref: "passed" }] }] }, AGENT)
    );
    expect(updateMs).toBeLessThan(100);

    // Context lookup on a deep node
    const { ms: ctxMs } = time("swimlanes_context (deep read)", () =>
      handleContext({ node_id: nodeId })
    );
    expect(ctxMs).toBeLessThan(100);
  });
});

describe("scale: 1000 nodes", () => {
  beforeEach(() => initDb(":memory:"));

  it("still performs within bounds", () => {
    console.log("\n=== 1000 nodes ===");

    const { ms: buildMs } = time("build 1000 nodes", () => buildProject("scale-1k", 1000));
    expect(buildMs).toBeLessThan(10000);

    const { result: next, ms: nextMs } = time("swimlanes_next (top 5)", () =>
      handleNext({ project: "scale-1k", count: 5 }, AGENT)
    );
    expect(next.nodes.length).toBeGreaterThan(0);
    expect(nextMs).toBeLessThan(500);

    const { result: query, ms: queryMs } = time("swimlanes_query (actionable)", () =>
      handleQuery({ project: "scale-1k", filter: { is_actionable: true } })
    );
    expect(query.nodes.length).toBeGreaterThan(0);
    expect(queryMs).toBeLessThan(500);

    const { ms: openMs } = time("swimlanes_open (summary)", () =>
      handleOpen({ project: "scale-1k" }, AGENT)
    );
    expect(openMs).toBeLessThan(500);

    // Full claim-work-resolve cycle
    const { ms: cycleMs } = time("full claim→resolve cycle", () => {
      const n = handleNext({ project: "scale-1k", claim: true }, AGENT);
      handleUpdate({ updates: [{ node_id: n.nodes[0].node.id, resolved: true, add_evidence: [{ type: "test", ref: "done" }] }] }, AGENT);
    });
    expect(cycleMs).toBeLessThan(500);

    console.log("");
  });
});
