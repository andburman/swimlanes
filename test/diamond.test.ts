import { describe, it, expect, beforeEach } from "vitest";
import { initDb } from "../src/db.js";
import { handleOpen } from "../src/tools/open.js";
import { handlePlan } from "../src/tools/plan.js";
import { handleNext } from "../src/tools/next.js";
import { handleQuery } from "../src/tools/query.js";
import { handleUpdate } from "../src/tools/update.js";
import { handleContext } from "../src/tools/context.js";
import { handleConnect } from "../src/tools/connect.js";

const AGENT = "diamond-test";

beforeEach(() => {
  initDb(":memory:");
});

describe("diamond dependency", () => {
  //     A (top)
  //    / \
  //   B   C
  //    \ /
  //     D (base)
  //
  // A depends on B and C. B and C both depend on D.
  // Only D is actionable initially.
  // Resolve D → B and C unblock.
  // Resolve B and C → A unblocks.

  function setupDiamond() {
    const { root } = handleOpen({ project: "diamond", goal: "Diamond test" }, AGENT) as any;

    const plan = handlePlan(
      {
        nodes: [
          { ref: "d", parent_ref: root.id, summary: "D — base task", properties: { priority: 1 } },
          { ref: "b", parent_ref: root.id, summary: "B — left branch", depends_on: ["d"], properties: { priority: 5 } },
          { ref: "c", parent_ref: root.id, summary: "C — right branch", depends_on: ["d"], properties: { priority: 3 } },
          { ref: "a", parent_ref: root.id, summary: "A — top task", depends_on: ["b", "c"], properties: { priority: 10 } },
        ],
      },
      AGENT
    );

    const ids = Object.fromEntries(plan.created.map((c: any) => [c.ref, c.id]));
    return { root, ids };
  }

  it("only D is actionable initially", () => {
    setupDiamond();

    const actionable = handleQuery({ project: "diamond", filter: { is_actionable: true } });
    expect(actionable.nodes).toHaveLength(1);
    expect(actionable.nodes[0].summary).toBe("D — base task");

    const blocked = handleQuery({ project: "diamond", filter: { is_blocked: true } });
    expect(blocked.nodes).toHaveLength(3); // A, B, C all blocked

    const next = handleNext({ project: "diamond" }, AGENT);
    expect(next.nodes[0].node.summary).toBe("D — base task");
  });

  it("resolving D unblocks B and C but not A", () => {
    const { ids } = setupDiamond();

    const result = handleUpdate(
      { updates: [{ node_id: ids.d, resolved: true, add_evidence: [{ type: "note", ref: "base work done" }] }] },
      AGENT
    );

    // B and C should be newly actionable
    const actionableSummaries = result.newly_actionable!.map((n) => n.summary).sort();
    expect(actionableSummaries).toContain("B — left branch");
    expect(actionableSummaries).toContain("C — right branch");
    // A should NOT be in newly actionable (still blocked by B and C)
    expect(actionableSummaries).not.toContain("A — top task");

    // Verify via query
    const actionable = handleQuery({ project: "diamond", filter: { is_actionable: true } });
    expect(actionable.nodes).toHaveLength(2);
    const summaries = actionable.nodes.map((n) => n.summary).sort();
    expect(summaries).toEqual(["B — left branch", "C — right branch"]);

    // A is still blocked
    const blocked = handleQuery({ project: "diamond", filter: { is_blocked: true } });
    expect(blocked.nodes).toHaveLength(1);
    expect(blocked.nodes[0].summary).toBe("A — top task");
  });

  it("resolving B alone does not unblock A", () => {
    const { ids } = setupDiamond();

    handleUpdate({ updates: [{ node_id: ids.d, resolved: true, add_evidence: [{ type: "test", ref: "done" }] }] }, AGENT);
    const result = handleUpdate({ updates: [{ node_id: ids.b, resolved: true, add_evidence: [{ type: "test", ref: "done" }] }] }, AGENT);

    // A should not be in newly_actionable (C is still unresolved)
    const actionableSummaries = (result.newly_actionable ?? []).map((n) => n.summary);
    expect(actionableSummaries).not.toContain("A — top task");

    // A is still blocked
    const blocked = handleQuery({ project: "diamond", filter: { is_blocked: true } });
    expect(blocked.nodes).toHaveLength(1);
    expect(blocked.nodes[0].summary).toBe("A — top task");
  });

  it("resolving both B and C unblocks A", () => {
    const { ids } = setupDiamond();

    handleUpdate({ updates: [{ node_id: ids.d, resolved: true, add_evidence: [{ type: "test", ref: "done" }] }] }, AGENT);
    handleUpdate({ updates: [{ node_id: ids.b, resolved: true, add_evidence: [{ type: "test", ref: "done" }] }] }, AGENT);
    const result = handleUpdate({ updates: [{ node_id: ids.c, resolved: true, add_evidence: [{ type: "test", ref: "done" }] }] }, AGENT);

    // A should now be actionable
    const actionableSummaries = result.newly_actionable!.map((n) => n.summary);
    expect(actionableSummaries).toContain("A — top task");

    const next = handleNext({ project: "diamond" }, AGENT);
    expect(next.nodes[0].node.summary).toBe("A — top task");
  });

  it("full diamond walkthrough via swimlanes_next", () => {
    const { ids } = setupDiamond();

    // Step 1: next gives D
    const step1 = handleNext({ project: "diamond", claim: true }, AGENT);
    expect(step1.nodes[0].node.summary).toBe("D — base task");

    // Resolve D
    handleUpdate({ updates: [{ node_id: ids.d, resolved: true, add_evidence: [{ type: "test", ref: "done" }] }] }, AGENT);

    // Step 2: next gives B (higher priority than C)
    const step2 = handleNext({ project: "diamond", claim: true }, AGENT);
    expect(step2.nodes[0].node.summary).toBe("B — left branch");
    // Verify both B and C are available
    const step2all = handleNext({ project: "diamond", count: 5 }, AGENT);
    expect(step2all.nodes).toHaveLength(2);

    // Resolve B
    handleUpdate({ updates: [{ node_id: ids.b, resolved: true, add_evidence: [{ type: "test", ref: "done" }] }] }, AGENT);

    // Step 3: next gives C (only actionable)
    const step3 = handleNext({ project: "diamond" }, AGENT);
    expect(step3.nodes[0].node.summary).toBe("C — right branch");

    // Resolve C
    handleUpdate({ updates: [{ node_id: ids.c, resolved: true, add_evidence: [{ type: "test", ref: "done" }] }] }, AGENT);

    // Step 4: next gives A
    const step4 = handleNext({ project: "diamond" }, AGENT);
    expect(step4.nodes[0].node.summary).toBe("A — top task");

    // Resolve A
    handleUpdate({ updates: [{ node_id: ids.a, resolved: true, add_evidence: [{ type: "test", ref: "done" }] }] }, AGENT);

    // All done — root is now the only actionable
    // 4 resolved (D, B, C, A), root still unresolved
    const summary = handleOpen({ project: "diamond" }, AGENT) as any;
    expect(summary.summary.resolved).toBe(4);
    expect(summary.summary.actionable).toBe(1); // root
  });

  it("context shows dependency satisfaction status", () => {
    const { ids } = setupDiamond();

    // Before resolving D
    const ctxA = handleContext({ node_id: ids.a });
    expect(ctxA.depends_on).toHaveLength(2);
    expect(ctxA.depends_on.every((d: any) => d.satisfied === false)).toBe(true);

    // D's depended_on_by should show B and C
    const ctxD = handleContext({ node_id: ids.d });
    expect(ctxD.depended_by).toHaveLength(2);

    // Resolve D, check B's deps
    handleUpdate({ updates: [{ node_id: ids.d, resolved: true, add_evidence: [{ type: "test", ref: "done" }] }] }, AGENT);
    const ctxB = handleContext({ node_id: ids.b });
    expect(ctxB.depends_on).toHaveLength(1);
    expect(ctxB.depends_on[0].satisfied).toBe(true);
    expect(ctxB.depends_on[0].node.summary).toBe("D — base task");
  });
});

describe("double diamond", () => {
  //     E
  //    / \
  //   C   D
  //    \ /
  //     B
  //     |
  //     A (base)
  //
  // Stacked diamonds — two levels of convergence

  it("cascades correctly through stacked diamonds", () => {
    const { root } = handleOpen({ project: "double-diamond", goal: "Stacked diamonds" }, AGENT) as any;

    const plan = handlePlan(
      {
        nodes: [
          { ref: "a", parent_ref: root.id, summary: "A — foundation" },
          { ref: "b", parent_ref: root.id, summary: "B — middle convergence", depends_on: ["a"] },
          { ref: "c", parent_ref: root.id, summary: "C — left upper", depends_on: ["b"] },
          { ref: "d", parent_ref: root.id, summary: "D — right upper", depends_on: ["b"] },
          { ref: "e", parent_ref: root.id, summary: "E — top convergence", depends_on: ["c", "d"] },
        ],
      },
      AGENT
    );

    const ids = Object.fromEntries(plan.created.map((c: any) => [c.ref, c.id]));

    // Only A is actionable
    let next = handleNext({ project: "double-diamond", count: 10 }, AGENT);
    expect(next.nodes).toHaveLength(1);
    expect(next.nodes[0].node.summary).toBe("A — foundation");

    // Resolve A → B unblocks
    let result = handleUpdate({ updates: [{ node_id: ids.a, resolved: true, add_evidence: [{ type: "test", ref: "done" }] }] }, AGENT);
    expect(result.newly_actionable!.some((n) => n.summary === "B — middle convergence")).toBe(true);

    // Resolve B → C and D unblock
    result = handleUpdate({ updates: [{ node_id: ids.b, resolved: true, add_evidence: [{ type: "test", ref: "done" }] }] }, AGENT);
    const unblocked = result.newly_actionable!.map((n) => n.summary).sort();
    expect(unblocked).toContain("C — left upper");
    expect(unblocked).toContain("D — right upper");
    expect(unblocked).not.toContain("E — top convergence");

    // Resolve C only — E still blocked
    result = handleUpdate({ updates: [{ node_id: ids.c, resolved: true, add_evidence: [{ type: "test", ref: "done" }] }] }, AGENT);
    expect((result.newly_actionable ?? []).map((n) => n.summary)).not.toContain("E — top convergence");

    // Resolve D — E unblocks
    result = handleUpdate({ updates: [{ node_id: ids.d, resolved: true, add_evidence: [{ type: "test", ref: "done" }] }] }, AGENT);
    expect(result.newly_actionable!.some((n) => n.summary === "E — top convergence")).toBe(true);
  });
});

describe("wide fan-in", () => {
  // One node depends on 20 others — all must resolve before it unblocks

  it("unblocks only when ALL dependencies resolve", () => {
    const { root } = handleOpen({ project: "fan-in", goal: "Wide fan-in" }, AGENT) as any;

    const depCount = 20;
    const nodes: any[] = [];
    const depRefs: string[] = [];

    for (let i = 0; i < depCount; i++) {
      const ref = `dep-${i}`;
      depRefs.push(ref);
      nodes.push({ ref, parent_ref: root.id, summary: `Dependency ${i}` });
    }

    nodes.push({
      ref: "target",
      parent_ref: root.id,
      summary: "Target — needs all deps",
      depends_on: depRefs,
      properties: { priority: 100 },
    });

    const plan = handlePlan({ nodes }, AGENT);
    const ids = Object.fromEntries(plan.created.map((c: any) => [c.ref, c.id]));

    // Target is blocked
    let blocked = handleQuery({ project: "fan-in", filter: { is_blocked: true } });
    expect(blocked.nodes).toHaveLength(1);
    expect(blocked.nodes[0].summary).toBe("Target — needs all deps");

    // Resolve all but the last dep — target still blocked
    for (let i = 0; i < depCount - 1; i++) {
      handleUpdate({ updates: [{ node_id: ids[`dep-${i}`], resolved: true, add_evidence: [{ type: "test", ref: "done" }] }] }, AGENT);
    }

    blocked = handleQuery({ project: "fan-in", filter: { is_blocked: true } });
    expect(blocked.nodes).toHaveLength(1);

    // Resolve last dep — target unblocks
    const result = handleUpdate({ updates: [{ node_id: ids[`dep-${depCount - 1}`], resolved: true, add_evidence: [{ type: "test", ref: "done" }] }] }, AGENT);
    expect(result.newly_actionable!.some((n) => n.summary === "Target — needs all deps")).toBe(true);

    // swimlanes_next should return it (highest priority)
    const next = handleNext({ project: "fan-in" }, AGENT);
    expect(next.nodes[0].node.summary).toBe("Target — needs all deps");
  });
});

describe("fan-out then fan-in", () => {
  //       start
  //      /  |  \
  //    w1  w2  w3
  //      \  |  /
  //      finish
  //
  // Common pattern: one task kicks off parallel work, another waits for all of it

  it("handles parallel work correctly", () => {
    const { root } = handleOpen({ project: "fan-out-in", goal: "Fan-out then fan-in" }, AGENT) as any;

    const plan = handlePlan(
      {
        nodes: [
          { ref: "start", parent_ref: root.id, summary: "Start — kick off work", properties: { priority: 10 } },
          { ref: "w1", parent_ref: root.id, summary: "Worker 1", depends_on: ["start"], properties: { priority: 5 } },
          { ref: "w2", parent_ref: root.id, summary: "Worker 2", depends_on: ["start"], properties: { priority: 5 } },
          { ref: "w3", parent_ref: root.id, summary: "Worker 3", depends_on: ["start"], properties: { priority: 5 } },
          { ref: "finish", parent_ref: root.id, summary: "Finish — aggregate results", depends_on: ["w1", "w2", "w3"], properties: { priority: 10 } },
        ],
      },
      AGENT
    );

    const ids = Object.fromEntries(plan.created.map((c: any) => [c.ref, c.id]));

    // Only start is actionable
    let next = handleNext({ project: "fan-out-in", count: 10 }, AGENT);
    expect(next.nodes).toHaveLength(1);
    expect(next.nodes[0].node.summary).toBe("Start — kick off work");

    // Resolve start → 3 workers unblock
    let result = handleUpdate({ updates: [{ node_id: ids.start, resolved: true, add_evidence: [{ type: "test", ref: "done" }] }] }, AGENT);
    expect(result.newly_actionable!).toHaveLength(3);

    // All 3 workers actionable
    next = handleNext({ project: "fan-out-in", count: 10 }, AGENT);
    expect(next.nodes).toHaveLength(3);

    // Resolve workers one by one
    handleUpdate({ updates: [{ node_id: ids.w1, resolved: true, add_evidence: [{ type: "test", ref: "done" }] }] }, AGENT);
    handleUpdate({ updates: [{ node_id: ids.w2, resolved: true, add_evidence: [{ type: "test", ref: "done" }] }] }, AGENT);
    result = handleUpdate({ updates: [{ node_id: ids.w3, resolved: true, add_evidence: [{ type: "test", ref: "done" }] }] }, AGENT);

    // Finish unblocks
    expect(result.newly_actionable!.some((n) => n.summary === "Finish — aggregate results")).toBe(true);

    next = handleNext({ project: "fan-out-in" }, AGENT);
    expect(next.nodes[0].node.summary).toBe("Finish — aggregate results");
  });
});
