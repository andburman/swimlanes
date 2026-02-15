import { describe, it, expect, beforeEach } from "vitest";
import { initDb } from "../src/db.js";
import { handleOpen } from "../src/tools/open.js";
import { handlePlan } from "../src/tools/plan.js";
import { handleNext } from "../src/tools/next.js";
import { handleContext } from "../src/tools/context.js";
import { handleUpdate } from "../src/tools/update.js";
import { handleConnect } from "../src/tools/connect.js";
import { handleQuery } from "../src/tools/query.js";
import { handleRestructure } from "../src/tools/restructure.js";
import { handleHistory } from "../src/tools/history.js";
import { ValidationError, EngineError } from "../src/validate.js";

const AGENT = "test-agent";

beforeEach(() => {
  initDb(":memory:");
});

describe("graph_open", () => {
  it("lists projects when no project specified", () => {
    const result = handleOpen({}, AGENT) as any;
    expect(result.projects).toEqual([]);
  });

  it("creates a new project", () => {
    const result = handleOpen({ project: "test", goal: "Test goal" }, AGENT) as any;
    expect(result.root.summary).toBe("Test goal");
    expect(result.summary.total).toBe(1);
  });

  it("reopens existing project", () => {
    handleOpen({ project: "test", goal: "Goal" }, AGENT);
    const result = handleOpen({ project: "test" }, AGENT) as any;
    expect(result.root.summary).toBe("Goal");
  });
});

describe("graph_plan", () => {
  it("creates nodes with dependencies", () => {
    const { root } = handleOpen({ project: "test", goal: "Root" }, AGENT) as any;

    const result = handlePlan(
      {
        nodes: [
          { ref: "a", parent_ref: root.id, summary: "Task A" },
          { ref: "b", parent_ref: root.id, summary: "Task B", depends_on: ["a"] },
        ],
      },
      AGENT
    );

    expect(result.created).toHaveLength(2);

    // B should be blocked
    const query = handleQuery({ project: "test", filter: { is_blocked: true } });
    expect(query.nodes).toHaveLength(1);
    expect(query.nodes[0].summary).toBe("Task B");
  });

  it("rejects batch with missing parent", () => {
    expect(() =>
      handlePlan({ nodes: [{ ref: "a", parent_ref: "nonexistent", summary: "Task" }] }, AGENT)
    ).toThrow();
  });

  it("validates required fields", () => {
    expect(() => handlePlan({ nodes: [] as any }, AGENT)).toThrow(ValidationError);
    expect(() => handlePlan({} as any, AGENT)).toThrow(ValidationError);
  });
});

describe("graph_next", () => {
  it("returns highest priority actionable node", () => {
    const { root } = handleOpen({ project: "test" }, AGENT) as any;

    handlePlan(
      {
        nodes: [
          { ref: "low", parent_ref: root.id, summary: "Low", properties: { priority: 1 } },
          { ref: "high", parent_ref: root.id, summary: "High", properties: { priority: 10 } },
        ],
      },
      AGENT
    );

    const result = handleNext({ project: "test" }, AGENT);
    expect(result.nodes[0].node.summary).toBe("High");
  });

  it("skips blocked nodes", () => {
    const { root } = handleOpen({ project: "test" }, AGENT) as any;

    const plan = handlePlan(
      {
        nodes: [
          { ref: "a", parent_ref: root.id, summary: "A", properties: { priority: 5 } },
          { ref: "b", parent_ref: root.id, summary: "B (blocked)", depends_on: ["a"], properties: { priority: 10 } },
        ],
      },
      AGENT
    );

    const result = handleNext({ project: "test" }, AGENT);
    expect(result.nodes[0].node.summary).toBe("A");
  });

  it("includes ancestors and context links", () => {
    const { root } = handleOpen({ project: "test", goal: "Root goal" }, AGENT) as any;

    handlePlan(
      {
        nodes: [
          { ref: "child", parent_ref: root.id, summary: "Child", context_links: ["src/foo.ts"] },
        ],
      },
      AGENT
    );

    const result = handleNext({ project: "test" }, AGENT);
    expect(result.nodes[0].ancestors).toHaveLength(1);
    expect(result.nodes[0].ancestors[0].summary).toBe("Root goal");
    expect(result.nodes[0].context_links.self).toEqual(["src/foo.ts"]);
  });

  it("soft-claims when requested", () => {
    const { root } = handleOpen({ project: "test" }, AGENT) as any;
    handlePlan({ nodes: [{ ref: "a", parent_ref: root.id, summary: "Task" }] }, AGENT);

    const result = handleNext({ project: "test", claim: true }, AGENT);
    expect(result.nodes[0].node.properties._claimed_by).toBe(AGENT);
  });
});

describe("graph_context", () => {
  it("returns full neighborhood", () => {
    const { root } = handleOpen({ project: "test" }, AGENT) as any;

    const plan = handlePlan(
      {
        nodes: [
          { ref: "a", parent_ref: root.id, summary: "A" },
          { ref: "b", parent_ref: root.id, summary: "B", depends_on: ["a"] },
        ],
      },
      AGENT
    );

    const idB = plan.created.find((c) => c.ref === "b")!.id;
    const ctx = handleContext({ node_id: idB });

    expect(ctx.ancestors).toHaveLength(1);
    expect(ctx.depends_on).toHaveLength(1);
    expect(ctx.depends_on[0].node.summary).toBe("A");
    expect(ctx.depends_on[0].satisfied).toBe(false);
  });
});

describe("graph_update", () => {
  it("resolves nodes and reports newly actionable", () => {
    const { root } = handleOpen({ project: "test" }, AGENT) as any;

    const plan = handlePlan(
      {
        nodes: [
          { ref: "a", parent_ref: root.id, summary: "A" },
          { ref: "b", parent_ref: root.id, summary: "B", depends_on: ["a"] },
        ],
      },
      AGENT
    );

    const idA = plan.created.find((c) => c.ref === "a")!.id;
    const result = handleUpdate(
      { updates: [{ node_id: idA, resolved: true, add_evidence: [{ type: "test", ref: "passed" }] }] },
      AGENT
    );

    expect(result.updated[0].rev).toBe(2);
    expect(result.newly_actionable).toBeDefined();
    expect(result.newly_actionable!.some((n) => n.summary === "B")).toBe(true);
  });

  it("rejects resolve without evidence", () => {
    const { root } = handleOpen({ project: "test" }, AGENT) as any;
    handlePlan({ nodes: [{ ref: "a", parent_ref: root.id, summary: "A" }] }, AGENT);
    const query = handleQuery({ project: "test", filter: { is_actionable: true } });
    const nodeId = query.nodes[0].id;

    expect(() =>
      handleUpdate({ updates: [{ node_id: nodeId, resolved: true }] }, AGENT)
    ).toThrow(EngineError);
  });

  it("allows resolve with evidence", () => {
    const { root } = handleOpen({ project: "test" }, AGENT) as any;
    handlePlan({ nodes: [{ ref: "a", parent_ref: root.id, summary: "A" }] }, AGENT);
    const query = handleQuery({ project: "test", filter: { is_actionable: true } });
    const nodeId = query.nodes[0].id;

    const result = handleUpdate(
      { updates: [{ node_id: nodeId, resolved: true, add_evidence: [{ type: "note", ref: "completed" }] }] },
      AGENT
    );
    expect(result.updated[0].rev).toBe(2);
  });

  it("allows resolve when node already has evidence", () => {
    const { root } = handleOpen({ project: "test" }, AGENT) as any;
    handlePlan({ nodes: [{ ref: "a", parent_ref: root.id, summary: "A" }] }, AGENT);
    const query = handleQuery({ project: "test", filter: { is_actionable: true } });
    const nodeId = query.nodes[0].id;

    // Add evidence first
    handleUpdate(
      { updates: [{ node_id: nodeId, add_evidence: [{ type: "note", ref: "work in progress" }] }] },
      AGENT
    );

    // Resolve without new evidence — should work because node already has evidence
    const result = handleUpdate(
      { updates: [{ node_id: nodeId, resolved: true }] },
      AGENT
    );
    expect(result.updated[0].rev).toBe(3);
  });
});

describe("graph_connect", () => {
  it("adds and removes edges", () => {
    const { root } = handleOpen({ project: "test" }, AGENT) as any;
    const plan = handlePlan(
      {
        nodes: [
          { ref: "a", parent_ref: root.id, summary: "A" },
          { ref: "b", parent_ref: root.id, summary: "B" },
        ],
      },
      AGENT
    );

    const idA = plan.created.find((c) => c.ref === "a")!.id;
    const idB = plan.created.find((c) => c.ref === "b")!.id;

    const addResult = handleConnect({ edges: [{ from: idB, to: idA, type: "relates_to" }] }, AGENT);
    expect(addResult.applied).toBe(1);

    const removeResult = handleConnect(
      { edges: [{ from: idB, to: idA, type: "relates_to", remove: true }] },
      AGENT
    );
    expect(removeResult.applied).toBe(1);
  });

  it("rejects parent edges", () => {
    const { root } = handleOpen({ project: "test" }, AGENT) as any;
    const plan = handlePlan(
      { nodes: [{ ref: "a", parent_ref: root.id, summary: "A" }] },
      AGENT
    );

    const result = handleConnect(
      { edges: [{ from: plan.created[0].id, to: root.id, type: "parent" }] },
      AGENT
    );
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected![0].reason).toContain("parent_edges_not_allowed");
  });
});

describe("graph_query", () => {
  it("filters by text", () => {
    const { root } = handleOpen({ project: "test" }, AGENT) as any;
    handlePlan(
      {
        nodes: [
          { ref: "a", parent_ref: root.id, summary: "Auth module" },
          { ref: "b", parent_ref: root.id, summary: "Database layer" },
        ],
      },
      AGENT
    );

    const result = handleQuery({ project: "test", filter: { text: "Auth" } });
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].summary).toBe("Auth module");
  });

  it("filters by actionable", () => {
    const { root } = handleOpen({ project: "test" }, AGENT) as any;
    handlePlan(
      {
        nodes: [
          { ref: "a", parent_ref: root.id, summary: "A" },
          { ref: "b", parent_ref: root.id, summary: "B", depends_on: ["a"] },
        ],
      },
      AGENT
    );

    const result = handleQuery({ project: "test", filter: { is_actionable: true } });
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].summary).toBe("A");
  });
});

describe("graph_restructure", () => {
  it("moves a node", () => {
    const { root } = handleOpen({ project: "test" }, AGENT) as any;
    const plan = handlePlan(
      {
        nodes: [
          { ref: "parent1", parent_ref: root.id, summary: "Parent 1" },
          { ref: "parent2", parent_ref: root.id, summary: "Parent 2" },
          { ref: "child", parent_ref: "parent1", summary: "Child" },
        ],
      },
      AGENT
    );

    const childId = plan.created.find((c) => c.ref === "child")!.id;
    const parent2Id = plan.created.find((c) => c.ref === "parent2")!.id;

    const result = handleRestructure(
      { operations: [{ op: "move", node_id: childId, new_parent: parent2Id }] },
      AGENT
    );

    expect(result.applied).toBe(1);
    const ctx = handleContext({ node_id: parent2Id });
    expect(ctx.children.children).toHaveLength(1);
  });

  it("drops a subtree", () => {
    const { root } = handleOpen({ project: "test" }, AGENT) as any;
    const plan = handlePlan(
      {
        nodes: [
          { ref: "a", parent_ref: root.id, summary: "A" },
          { ref: "a1", parent_ref: "a", summary: "A.1" },
        ],
      },
      AGENT
    );

    const idA = plan.created.find((c) => c.ref === "a")!.id;

    handleRestructure(
      { operations: [{ op: "drop", node_id: idA, reason: "Not needed" }] },
      AGENT
    );

    const summary = handleOpen({ project: "test" }, AGENT) as any;
    expect(summary.summary.resolved).toBe(2); // A + A.1 resolved, root stays unresolved
  });
});

describe("graph_history", () => {
  it("returns audit trail", () => {
    const { root } = handleOpen({ project: "test" }, AGENT) as any;
    handleUpdate(
      { updates: [{ node_id: root.id, summary: "Updated" }] },
      AGENT
    );

    const result = handleHistory({ node_id: root.id });
    expect(result.events.length).toBeGreaterThanOrEqual(2);
    const actions = result.events.map((e) => e.action);
    expect(actions).toContain("created");
    expect(actions).toContain("updated");
  });
});

describe("full workflow", () => {
  it("plan -> claim -> work -> resolve -> unblock", () => {
    // Open project
    const { root } = handleOpen({ project: "workflow", goal: "Build feature" }, AGENT) as any;

    // Plan work
    const plan = handlePlan(
      {
        nodes: [
          { ref: "design", parent_ref: root.id, summary: "Design API", properties: { priority: 10 } },
          { ref: "impl", parent_ref: root.id, summary: "Implement", depends_on: ["design"], properties: { priority: 5 } },
          { ref: "test", parent_ref: root.id, summary: "Test", depends_on: ["impl"], properties: { priority: 3 } },
        ],
      },
      AGENT
    );

    // Claim next
    const next1 = handleNext({ project: "workflow", claim: true }, AGENT);
    expect(next1.nodes[0].node.summary).toBe("Design API");

    // Resolve design
    const designId = plan.created.find((c) => c.ref === "design")!.id;
    const update1 = handleUpdate(
      {
        updates: [
          {
            node_id: designId,
            resolved: true,
            add_evidence: [{ type: "note", ref: "REST API with 3 endpoints" }],
          },
        ],
      },
      AGENT
    );
    expect(update1.newly_actionable!.some((n) => n.summary === "Implement")).toBe(true);

    // Next should be "Implement"
    const next2 = handleNext({ project: "workflow" }, AGENT);
    expect(next2.nodes[0].node.summary).toBe("Implement");

    // Resolve implement
    const implId = plan.created.find((c) => c.ref === "impl")!.id;
    handleUpdate({ updates: [{ node_id: implId, resolved: true, add_evidence: [{ type: "test", ref: "done" }] }] }, AGENT);

    // Next should be "Test"
    const next3 = handleNext({ project: "workflow" }, AGENT);
    expect(next3.nodes[0].node.summary).toBe("Test");

    // Final summary
    const summary = handleOpen({ project: "workflow" }, AGENT) as any;
    expect(summary.summary.resolved).toBe(2);
    expect(summary.summary.actionable).toBe(1);
  });
});
