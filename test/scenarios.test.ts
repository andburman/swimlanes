import { describe, it, expect, beforeEach } from "vitest";
import { initDb } from "../src/db.js";
import { handleOpen } from "../src/tools/open.js";
import { handlePlan } from "../src/tools/plan.js";
import { handleNext } from "../src/tools/next.js";
import { handleQuery } from "../src/tools/query.js";
import { handleUpdate } from "../src/tools/update.js";
import { handleContext } from "../src/tools/context.js";
import { handleRestructure } from "../src/tools/restructure.js";
import { handleHistory } from "../src/tools/history.js";
import { handleConnect } from "../src/tools/connect.js";
import { updateNode } from "../src/nodes.js";
import { EngineError } from "../src/validate.js";

/** Open a project and clear discovery so tests can plan immediately */
function openProject(project: string, goal: string, agent: string) {
  const result = handleOpen({ project, goal }, agent) as any;
  updateNode({ node_id: result.root.id, agent, discovery: "done" });
  return result;
}

beforeEach(() => {
  initDb(":memory:");
});

// ============================================================
// Scenario: Deep decomposition (5+ levels)
// ============================================================

describe("deep decomposition", () => {
  // root
  //   └── phase1 (depth 1)
  //       └── module (depth 2)
  //           └── feature (depth 3)
  //               └── component (depth 4)
  //                   └── task (depth 5)

  it("tracks depth correctly across 5+ levels", () => {
    const { root } = openProject("deep", "Deep nesting test", "agent") as any;

    const plan = handlePlan({
      nodes: [
        { ref: "phase1", parent_ref: root.id, summary: "Phase 1" },
        { ref: "module", parent_ref: "phase1", summary: "Auth Module" },
        { ref: "feature", parent_ref: "module", summary: "Login Feature" },
        { ref: "component", parent_ref: "feature", summary: "Login Form Component" },
        { ref: "task", parent_ref: "component", summary: "Add password validation" },
      ],
    }, "agent");

    const ids = Object.fromEntries(plan.created.map((c: any) => [c.ref, c.id]));

    // Verify depths
    const query = handleQuery({ project: "deep", limit: 100 });
    const depthMap = Object.fromEntries(query.nodes.map((n) => [n.summary, n.depth]));

    expect(depthMap["Phase 1"]).toBe(1);
    expect(depthMap["Auth Module"]).toBe(2);
    expect(depthMap["Login Feature"]).toBe(3);
    expect(depthMap["Login Form Component"]).toBe(4);
    expect(depthMap["Add password validation"]).toBe(5);
  });

  it("only the deepest leaf is actionable", () => {
    const { root } = openProject("deep", "Deep nesting", "agent") as any;

    handlePlan({
      nodes: [
        { ref: "l1", parent_ref: root.id, summary: "Level 1" },
        { ref: "l2", parent_ref: "l1", summary: "Level 2" },
        { ref: "l3", parent_ref: "l2", summary: "Level 3" },
        { ref: "l4", parent_ref: "l3", summary: "Level 4" },
        { ref: "leaf", parent_ref: "l4", summary: "The Leaf Task" },
      ],
    }, "agent");

    const actionable = handleQuery({ project: "deep", filter: { is_actionable: true } });
    expect(actionable.nodes).toHaveLength(1);
    expect(actionable.nodes[0].summary).toBe("The Leaf Task");
  });

  it("ancestor chain is complete in graph_next", () => {
    const { root } = openProject("deep", "Root", "agent") as any;

    handlePlan({
      nodes: [
        { ref: "a", parent_ref: root.id, summary: "A" },
        { ref: "b", parent_ref: "a", summary: "B" },
        { ref: "c", parent_ref: "b", summary: "C" },
        { ref: "d", parent_ref: "c", summary: "D" },
        { ref: "leaf", parent_ref: "d", summary: "Leaf" },
      ],
    }, "agent");

    const next = handleNext({ project: "deep" }, "agent");
    expect(next.nodes[0].node.summary).toBe("Leaf");
    expect(next.nodes[0].ancestors).toHaveLength(5); // root, A, B, C, D
    expect(next.nodes[0].ancestors.map((a) => a.summary)).toEqual(["Root", "A", "B", "C", "D"]);
  });

  it("resolving leaf auto-resolves single-child chain", () => {
    const { root } = openProject("deep", "deep", "agent") as any;

    const plan = handlePlan({
      nodes: [
        { ref: "parent", parent_ref: root.id, summary: "Parent" },
        { ref: "child", parent_ref: "parent", summary: "Child" },
      ],
    }, "agent");

    const ids = Object.fromEntries(plan.created.map((c: any) => [c.ref, c.id]));

    // Only child is actionable (parent has unresolved child)
    let actionable = handleQuery({ project: "deep", filter: { is_actionable: true } });
    expect(actionable.nodes).toHaveLength(1);
    expect(actionable.nodes[0].summary).toBe("Child");

    // Resolve child — parent auto-resolves (1 level cascade by default)
    const result = handleUpdate({
      updates: [{ node_id: ids.child, resolved: true, add_evidence: [{ type: "note", ref: "done" }] }],
    }, "agent");
    expect(result.auto_resolved!.some((n) => n.summary === "Parent")).toBe(true);

    // Root does NOT auto-resolve (cascade limited to 1 level)
    const summary = handleOpen({ project: "deep" }, "agent") as any;
    expect(summary.summary.resolved).toBe(2); // child + parent
  });
});

// ============================================================
// Scenario: Mid-flight replanning
// ============================================================

describe("mid-flight replanning", () => {
  it("adds new tasks to a partially completed project", () => {
    const { root } = openProject("replan", "Build MVP", "agent") as any;

    // Initial plan: 3 tasks
    const plan = handlePlan({
      nodes: [
        { ref: "auth", parent_ref: root.id, summary: "Build auth", properties: { priority: 10 } },
        { ref: "api", parent_ref: root.id, summary: "Build API", depends_on: ["auth"], properties: { priority: 8 } },
        { ref: "ui", parent_ref: root.id, summary: "Build UI", depends_on: ["api"], properties: { priority: 5 } },
      ],
    }, "agent");

    const ids = Object.fromEntries(plan.created.map((c: any) => [c.ref, c.id]));

    // Complete auth
    handleUpdate({
      updates: [{ node_id: ids.auth, resolved: true, add_evidence: [{ type: "git", ref: "abc123 — Supabase auth" }] }],
    }, "agent");

    // Mid-flight: discover we need a database migration task
    const replan = handlePlan({
      nodes: [
        { ref: "migration", parent_ref: root.id, summary: "Database migration", properties: { priority: 9 } },
      ],
    }, "agent");

    const migrationId = replan.created[0].id;

    // Add dependency: API depends on migration too
    handleConnect({ edges: [{ from: ids.api, to: migrationId, type: "depends_on" }] }, "agent");

    // API should now be blocked (migration not done)
    const blocked = handleQuery({ project: "replan", filter: { is_blocked: true } });
    const blockedSummaries = blocked.nodes.map((n) => n.summary);
    expect(blockedSummaries).toContain("Build API");

    // Migration should be actionable (highest priority among actionable)
    const next = handleNext({ project: "replan" }, "agent");
    expect(next.nodes[0].node.summary).toBe("Database migration");

    // Resolve migration — API unblocks
    const result = handleUpdate({
      updates: [{ node_id: migrationId, resolved: true, add_evidence: [{ type: "note", ref: "schema updated" }] }],
    }, "agent");
    expect(result.newly_actionable!.some((n) => n.summary === "Build API")).toBe(true);
  });

  it("reprioritizes tasks mid-project", () => {
    const { root } = openProject("reprio", "Reprioritize", "agent") as any;

    const plan = handlePlan({
      nodes: [
        { ref: "a", parent_ref: root.id, summary: "Low priority task", properties: { priority: 1 } },
        { ref: "b", parent_ref: root.id, summary: "Medium priority task", properties: { priority: 5 } },
      ],
    }, "agent");

    const ids = Object.fromEntries(plan.created.map((c: any) => [c.ref, c.id]));

    // B is first (higher priority)
    let next = handleNext({ project: "reprio" }, "agent");
    expect(next.nodes[0].node.summary).toBe("Medium priority task");

    // Reprioritize: A becomes urgent
    handleUpdate({
      updates: [{ node_id: ids.a, properties: { priority: 100 } }],
    }, "agent");

    // Now A is first
    next = handleNext({ project: "reprio" }, "agent");
    expect(next.nodes[0].node.summary).toBe("Low priority task");
    expect(next.nodes[0].node.properties.priority).toBe(100);
  });

  it("drops planned work that's no longer needed", () => {
    const { root } = openProject("drop", "Drop test", "agent") as any;

    const plan = handlePlan({
      nodes: [
        { ref: "keep", parent_ref: root.id, summary: "Keep this" },
        { ref: "drop-parent", parent_ref: root.id, summary: "Drop this subtree" },
        { ref: "drop-child", parent_ref: "drop-parent", summary: "Child of dropped" },
        { ref: "blocked", parent_ref: root.id, summary: "Was blocked by dropped", depends_on: ["drop-parent"] },
      ],
    }, "agent");

    const ids = Object.fromEntries(plan.created.map((c: any) => [c.ref, c.id]));

    // Drop the subtree
    const result = handleRestructure({
      operations: [{ op: "drop", node_id: ids["drop-parent"], reason: "Requirements changed" }],
    }, "agent");

    expect(result.applied).toBe(1);

    // Blocked task should now be actionable (drop resolves the dependency)
    const actionable = handleQuery({ project: "drop", filter: { is_actionable: true } });
    const summaries = actionable.nodes.map((n) => n.summary);
    expect(summaries).toContain("Keep this");
    expect(summaries).toContain("Was blocked by dropped");
  });
});

// ============================================================
// Scenario: Multi-agent coordination
// ============================================================

describe("multi-agent coordination", () => {
  it("two agents claim different tasks", () => {
    const { root } = openProject("multi", "Multi-agent", "agent-1") as any;

    handlePlan({
      nodes: [
        { ref: "a", parent_ref: root.id, summary: "Task A", properties: { priority: 10 } },
        { ref: "b", parent_ref: root.id, summary: "Task B", properties: { priority: 9 } },
        { ref: "c", parent_ref: root.id, summary: "Task C", properties: { priority: 8 } },
      ],
    }, "agent-1");

    // Agent 1 claims top task
    const next1 = handleNext({ project: "multi", claim: true }, "agent-1");
    expect(next1.nodes[0].node.summary).toBe("Task A");
    expect(next1.nodes[0].node.properties._claimed_by).toBe("agent-1");

    // Agent 2 gets next unclaimed task (skips A)
    const next2 = handleNext({ project: "multi", claim: true }, "agent-2");
    expect(next2.nodes[0].node.summary).toBe("Task B");
    expect(next2.nodes[0].node.properties._claimed_by).toBe("agent-2");

    // Agent 3 gets the remaining task
    const next3 = handleNext({ project: "multi", claim: true }, "agent-3");
    expect(next3.nodes[0].node.summary).toBe("Task C");
  });

  it("stale claims expire and can be reclaimed", () => {
    const { root } = openProject("stale", "Claim expiry", "agent-1") as any;

    handlePlan({
      nodes: [{ ref: "a", parent_ref: root.id, summary: "Task A" }],
    }, "agent-1");

    // Agent 1 claims it
    handleNext({ project: "stale", claim: true }, "agent-1");

    // Agent 2 with default TTL can't get it (claim is fresh)
    const next2 = handleNext({ project: "stale" }, "agent-2");
    expect(next2.nodes).toHaveLength(0);

    // Agent 2 with TTL=0 (expired claims only) can reclaim
    const next3 = handleNext({ project: "stale", claim: true }, "agent-2", 0);
    expect(next3.nodes).toHaveLength(1);
    expect(next3.nodes[0].node.summary).toBe("Task A");
    expect(next3.nodes[0].node.properties._claimed_by).toBe("agent-2");
  });

  it("agent can see its own claimed tasks", () => {
    const { root } = openProject("my-claims", "Query claims", "agent-1") as any;

    handlePlan({
      nodes: [
        { ref: "a", parent_ref: root.id, summary: "Task A" },
        { ref: "b", parent_ref: root.id, summary: "Task B" },
      ],
    }, "agent-1");

    // Agent 1 claims A
    handleNext({ project: "my-claims", claim: true }, "agent-1");

    // Query for agent-1's claims
    const mine = handleQuery({ project: "my-claims", filter: { claimed_by: "agent-1" } });
    expect(mine.nodes).toHaveLength(1);
    expect(mine.nodes[0].summary).toBe("Task A");

    // Query for unclaimed
    const unclaimed = handleQuery({ project: "my-claims", filter: { claimed_by: null } });
    expect(unclaimed.nodes.some((n) => n.summary === "Task B")).toBe(true);
  });
});

// ============================================================
// Scenario: Cross-session pickup
// ============================================================

describe("cross-session pickup", () => {
  it("second agent reconstructs full project state", () => {
    // === SESSION 1: Agent 1 creates project, does partial work ===
    const { root } = openProject("session-test", "Build a feature", "agent-1") as any;

    const plan = handlePlan({
      nodes: [
        { ref: "design", parent_ref: root.id, summary: "Design the API", properties: { priority: 10 } },
        { ref: "implement", parent_ref: root.id, summary: "Implement endpoints", depends_on: ["design"], properties: { priority: 8 } },
        { ref: "test", parent_ref: root.id, summary: "Write tests", depends_on: ["implement"], properties: { priority: 5 } },
        { ref: "deploy", parent_ref: root.id, summary: "Deploy to staging", depends_on: ["test"], properties: { priority: 3 } },
      ],
    }, "agent-1");

    const ids = Object.fromEntries(plan.created.map((c: any) => [c.ref, c.id]));

    // Agent 1 completes design
    handleUpdate({
      updates: [{
        node_id: ids.design,
        resolved: true,
        add_evidence: [
          { type: "note", ref: "REST API with /bands, /venues, /bookings endpoints" },
          { type: "git", ref: "abc123 — API design doc" },
        ],
        add_context_links: ["docs/api-design.md"],
      }],
    }, "agent-1");

    // Agent 1 starts implementing, adds evidence but doesn't finish
    handleUpdate({
      updates: [{
        node_id: ids.implement,
        add_evidence: [{ type: "note", ref: "Started /bands endpoint, /venues still TODO" }],
        add_context_links: ["src/routes/bands.ts"],
      }],
    }, "agent-1");

    // === SESSION 2: Agent 2 picks up ===

    // Step 1: Open project — get summary
    const summary = handleOpen({ project: "session-test" }, "agent-2") as any;
    expect(summary.summary.total).toBe(5); // root + 4 tasks
    expect(summary.summary.resolved).toBe(1); // design
    expect(summary.summary.actionable).toBe(1); // implement

    // Step 2: Get next actionable — should be implement
    const next = handleNext({ project: "session-test" }, "agent-2");
    expect(next.nodes[0].node.summary).toBe("Implement endpoints");

    // Agent 2 can see the resolved deps (design) with evidence
    expect(next.nodes[0].resolved_deps).toHaveLength(1);
    expect(next.nodes[0].resolved_deps[0].summary).toBe("Design the API");
    expect(next.nodes[0].resolved_deps[0].evidence.some(
      (e) => e.ref.includes("REST API with /bands")
    )).toBe(true);

    // Agent 2 can see context links (files agent 1 was working on)
    expect(next.nodes[0].context_links.self).toContain("src/routes/bands.ts");

    // Agent 2 can see the implement node already has in-progress evidence
    expect(next.nodes[0].node.evidence).toHaveLength(1);
    expect(next.nodes[0].node.evidence[0].ref).toContain("Started /bands");

    // Step 3: Agent 2 checks what's blocked
    const blocked = handleQuery({ project: "session-test", filter: { is_blocked: true } });
    expect(blocked.nodes).toHaveLength(2); // test, deploy
    expect(blocked.nodes.map((n) => n.summary).sort()).toEqual(["Deploy to staging", "Write tests"]);

    // Step 4: Agent 2 finishes implementation
    handleUpdate({
      updates: [{
        node_id: ids.implement,
        resolved: true,
        add_evidence: [
          { type: "note", ref: "Completed /venues and /bookings endpoints" },
          { type: "git", ref: "def456 — All API endpoints implemented" },
        ],
        add_context_links: ["src/routes/venues.ts", "src/routes/bookings.ts"],
      }],
    }, "agent-2");

    // Test task should now be actionable
    const next2 = handleNext({ project: "session-test" }, "agent-2");
    expect(next2.nodes[0].node.summary).toBe("Write tests");
  });

  it("history shows work across agents", () => {
    const { root } = openProject("history-test", "History test", "agent-1") as any;

    const plan = handlePlan({
      nodes: [{ ref: "task", parent_ref: root.id, summary: "Shared task" }],
    }, "agent-1");

    const taskId = plan.created[0].id;

    // Agent 1 adds evidence
    handleUpdate({
      updates: [{ node_id: taskId, add_evidence: [{ type: "note", ref: "Agent 1 started work" }] }],
    }, "agent-1");

    // Agent 2 resolves
    handleUpdate({
      updates: [{ node_id: taskId, resolved: true, add_evidence: [{ type: "note", ref: "Agent 2 finished" }] }],
    }, "agent-2");

    // History shows both agents
    const history = handleHistory({ node_id: taskId });
    const agents = [...new Set(history.events.map((e: any) => e.agent))];
    expect(agents).toContain("agent-1");
    expect(agents).toContain("agent-2");

    // Evidence shows both agents' contributions
    const ctx = handleContext({ node_id: taskId });
    expect(ctx.node.evidence).toHaveLength(2);
    expect(ctx.node.evidence[0].agent).toBe("agent-1");
    expect(ctx.node.evidence[1].agent).toBe("agent-2");
  });
});

// ============================================================
// Scenario: Cascade resolution
// ============================================================

describe("cascade resolution", () => {
  // Single-child chain: resolving the leaf cascades actionability up

  it("single-child chain auto-resolves entirely when leaf resolves", () => {
    const { root } = openProject("cascade", "Cascade", "agent") as any;

    const plan = handlePlan({
      nodes: [
        { ref: "gp", parent_ref: root.id, summary: "Grandparent" },
        { ref: "parent", parent_ref: "gp", summary: "Parent" },
        { ref: "child", parent_ref: "parent", summary: "Child" },
      ],
    }, "agent");

    const ids = Object.fromEntries(plan.created.map((c: any) => [c.ref, c.id]));

    // Only child is actionable
    let next = handleNext({ project: "cascade" }, "agent");
    expect(next.nodes[0].node.summary).toBe("Child");

    // Resolve child → parent auto-resolves (1 level). Grandparent and root stay unresolved.
    const result = handleUpdate({
      updates: [{ node_id: ids.child, resolved: true, add_evidence: [{ type: "note", ref: "done" }] }],
    }, "agent");

    const autoResolved = result.auto_resolved!.map((n) => n.summary);
    expect(autoResolved).toContain("Parent");
    expect(autoResolved).not.toContain("Grandparent"); // 1-level cascade limit

    const summary = handleOpen({ project: "cascade" }, "agent") as any;
    expect(summary.summary.resolved).toBe(2); // child + parent
  });

  it("auto-resolved nodes get synthetic evidence", () => {
    const { root } = openProject("evidence", "Evidence", "agent") as any;

    const plan = handlePlan({
      nodes: [
        { ref: "parent", parent_ref: root.id, summary: "Parent" },
        { ref: "child", parent_ref: "parent", summary: "Child" },
      ],
    }, "agent");

    const ids = Object.fromEntries(plan.created.map((c: any) => [c.ref, c.id]));

    // Resolve child — parent auto-resolves
    handleUpdate({
      updates: [{ node_id: ids.child, resolved: true, add_evidence: [{ type: "note", ref: "done" }] }],
    }, "agent");

    // Check parent has synthetic evidence
    const ctx = handleContext({ node_id: ids.parent });
    expect(ctx.node.resolved).toBe(true);
    expect(ctx.node.evidence).toHaveLength(1);
    expect(ctx.node.evidence[0].ref).toBe("1/1 children resolved");
    expect(ctx.node.evidence[0].type).toBe("auto_resolve");
  });

  it("does not auto-resolve parent with mix of resolved and unresolved children", () => {
    const { root } = openProject("no-auto", "No auto", "agent") as any;

    const plan = handlePlan({
      nodes: [
        { ref: "parent", parent_ref: root.id, summary: "Parent" },
        { ref: "c1", parent_ref: "parent", summary: "Child 1" },
        { ref: "c2", parent_ref: "parent", summary: "Child 2" },
      ],
    }, "agent");

    const ids = Object.fromEntries(plan.created.map((c: any) => [c.ref, c.id]));

    // Resolve only c1
    const result = handleUpdate({
      updates: [{ node_id: ids.c1, resolved: true, add_evidence: [{ type: "note", ref: "done" }] }],
    }, "agent");

    // Parent should NOT be auto-resolved
    expect(result.auto_resolved ?? []).toHaveLength(0);

    const ctx = handleContext({ node_id: ids.parent });
    expect(ctx.node.resolved).toBe(false);
  });

  it("multi-child parent waits for all children", () => {
    const { root } = openProject("multi-child", "Multi-child", "agent") as any;

    const plan = handlePlan({
      nodes: [
        { ref: "parent", parent_ref: root.id, summary: "Parent" },
        { ref: "c1", parent_ref: "parent", summary: "Child 1" },
        { ref: "c2", parent_ref: "parent", summary: "Child 2" },
        { ref: "c3", parent_ref: "parent", summary: "Child 3" },
      ],
    }, "agent");

    const ids = Object.fromEntries(plan.created.map((c: any) => [c.ref, c.id]));

    // All 3 children are actionable
    let actionable = handleQuery({ project: "multi-child", filter: { is_actionable: true } });
    expect(actionable.nodes).toHaveLength(3);

    // Resolve first two — parent still not actionable
    handleUpdate({
      updates: [{ node_id: ids.c1, resolved: true, add_evidence: [{ type: "note", ref: "done" }] }],
    }, "agent");
    handleUpdate({
      updates: [{ node_id: ids.c2, resolved: true, add_evidence: [{ type: "note", ref: "done" }] }],
    }, "agent");

    actionable = handleQuery({ project: "multi-child", filter: { is_actionable: true } });
    expect(actionable.nodes).toHaveLength(1);
    expect(actionable.nodes[0].summary).toBe("Child 3"); // parent still not actionable

    // Resolve last child — parent auto-resolves (root does NOT — 1 level cascade)
    const result = handleUpdate({
      updates: [{ node_id: ids.c3, resolved: true, add_evidence: [{ type: "note", ref: "done" }] }],
    }, "agent");
    expect(result.auto_resolved!.some((n) => n.summary === "Parent")).toBe(true);

    const summary = handleOpen({ project: "multi-child" }, "agent") as any;
    expect(summary.summary.resolved).toBe(4); // c1 + c2 + c3 + parent (root stays unresolved)
  });
});
