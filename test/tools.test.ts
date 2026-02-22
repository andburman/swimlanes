import { describe, it, expect, beforeEach, vi } from "vitest";
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
import { handleOnboard } from "../src/tools/onboard.js";
import { handleAgentConfig } from "../src/tools/agent-config.js";
import { handleTree } from "../src/tools/tree.js";
import { handleStatus } from "../src/tools/status.js";
import { handleKnowledgeWrite, handleKnowledgeRead, handleKnowledgeDelete, handleKnowledgeSearch } from "../src/tools/knowledge.js";
import { handleRetro } from "../src/tools/retro.js";
import { handleResolve } from "../src/tools/resolve.js";
import { updateNode } from "../src/nodes.js";
import { ValidationError, EngineError } from "../src/validate.js";
import { computeContinuityConfidence } from "../src/continuity.js";
import { computeIntegrity } from "../src/integrity.js";
import { getDb } from "../src/db.js";

const AGENT = "test-agent";

function openProject(project: string, goal: string, agent: string) {
  const result = handleOpen({ project, goal }, agent) as any;
  updateNode({ node_id: result.root.id, agent, discovery: "done" });
  return result;
}

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

  it("returns hint for new project", () => {
    const result = handleOpen({ project: "new", goal: "Build something" }, AGENT) as any;
    expect(result.hint).toContain("Discovery is pending");
  });

  it("new projects always start with discovery pending", () => {
    const result = handleOpen({ project: "quick", goal: "Quick project" }, AGENT) as any;
    expect(result.root.discovery).toBe("pending");
    expect(result.hint).toContain("Discovery");
  });

  it("returns hint for project with actionable tasks", () => {
    const { root } = openProject("active", "Active", AGENT) as any;
    handlePlan({ nodes: [{ ref: "a", parent_ref: root.id, summary: "Task A" }] }, AGENT);
    const result = handleOpen({ project: "active" }, AGENT) as any;
    expect(result.hint).toContain("actionable");
  });
});

describe("graph_plan", () => {
  it("creates nodes with dependencies", () => {
    const { root } = openProject("test", "Root", AGENT) as any;

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

describe("discovery enforcement", () => {
  it("graph_open sets discovery:pending on new project roots", () => {
    const { root } = handleOpen({ project: "disc", goal: "Test discovery" }, AGENT) as any;
    const ctx = handleContext({ node_id: root.id });
    expect(ctx.node.discovery).toBe("pending");
  });

  it("graph_plan rejects children when parent has discovery:pending", () => {
    const { root } = handleOpen({ project: "disc", goal: "Test" }, AGENT) as any;
    // root has discovery:pending — graph_plan should refuse
    expect(() =>
      handlePlan({ nodes: [{ ref: "a", parent_ref: root.id, summary: "Task A" }] }, AGENT)
    ).toThrow(EngineError);
    expect(() =>
      handlePlan({ nodes: [{ ref: "a", parent_ref: root.id, summary: "Task A" }] }, AGENT)
    ).toThrow(/discovery.*pending/i);
  });

  it("graph_plan allows children when parent has discovery:done", () => {
    const { root } = handleOpen({ project: "disc", goal: "Test" }, AGENT) as any;
    updateNode({ node_id: root.id, agent: AGENT, discovery: "done" });

    const result = handlePlan(
      { nodes: [{ ref: "a", parent_ref: root.id, summary: "Task A" }] },
      AGENT
    );
    expect(result.created).toHaveLength(1);
  });

  it("legacy nodes with discovery:null in DB are treated as done (allows children)", () => {
    const { root } = handleOpen({ project: "disc", goal: "Test" }, AGENT) as any;
    // Set discovery to null to simulate a legacy DB row
    updateNode({ node_id: root.id, agent: AGENT, discovery: null as any });

    // rowToNode maps null -> "done" for backward compat
    const ctx = handleContext({ node_id: root.id });
    expect(ctx.node.discovery).toBe("done");

    const result = handlePlan(
      { nodes: [{ ref: "a", parent_ref: root.id, summary: "Task A" }] },
      AGENT
    );
    expect(result.created).toHaveLength(1);
  });

  it("graph_update flips discovery from pending to done", () => {
    const { root } = handleOpen({ project: "disc", goal: "Test" }, AGENT) as any;

    // Verify pending
    let ctx = handleContext({ node_id: root.id });
    expect(ctx.node.discovery).toBe("pending");

    // Flip to done
    handleUpdate(
      { updates: [{ node_id: root.id, discovery: "done" }] },
      AGENT
    );

    ctx = handleContext({ node_id: root.id });
    expect(ctx.node.discovery).toBe("done");
  });

  it("discovery change appears in audit history", () => {
    const { root } = handleOpen({ project: "disc", goal: "Test" }, AGENT) as any;
    handleUpdate(
      { updates: [{ node_id: root.id, discovery: "done" }] },
      AGENT
    );

    const history = handleHistory({ node_id: root.id });
    const discoveryEvent = history.events.find((e: any) =>
      e.changes && JSON.stringify(e.changes).includes("discovery")
    );
    expect(discoveryEvent).toBeDefined();
  });

  it("graph_plan sets discovery:done on batch parents, pending on leaf nodes", () => {
    const { root } = handleOpen({ project: "disc", goal: "Test" }, AGENT) as any;
    updateNode({ node_id: root.id, agent: AGENT, discovery: "done" });

    const result = handlePlan({
      nodes: [
        { ref: "parent", parent_ref: root.id, summary: "Parent task" },
        { ref: "child1", parent_ref: "parent", summary: "Child 1" },
        { ref: "child2", parent_ref: "parent", summary: "Child 2" },
      ],
    }, AGENT);

    // Parent in batch gets discovery:"done" (decomposition IS discovery)
    const parentCtx = handleContext({ node_id: result.created[0].id });
    expect(parentCtx.node.discovery).toBe("done");

    // Leaf nodes in batch get discovery:"pending"
    const child1Ctx = handleContext({ node_id: result.created[1].id });
    expect(child1Ctx.node.discovery).toBe("pending");

    const child2Ctx = handleContext({ node_id: result.created[2].id });
    expect(child2Ctx.node.discovery).toBe("pending");
  });

  it("all new nodes default to discovery:pending", () => {
    const { root } = handleOpen({ project: "disc", goal: "Test" }, AGENT) as any;
    updateNode({ node_id: root.id, agent: AGENT, discovery: "done" });

    const result = handlePlan({
      nodes: [{ ref: "leaf", parent_ref: root.id, summary: "A leaf task" }],
    }, AGENT);

    const ctx = handleContext({ node_id: result.created[0].id });
    expect(ctx.node.discovery).toBe("pending");
  });
});

describe("graph_next", () => {
  it("returns highest priority actionable node", () => {
    const { root } = openProject("test", "test", AGENT) as any;

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
    const { root } = openProject("test", "test", AGENT) as any;

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
    const { root } = openProject("test", "Root goal", AGENT) as any;

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

  it("scopes results to a subtree", () => {
    const { root } = openProject("test", "test", AGENT) as any;

    const plan = handlePlan(
      {
        nodes: [
          { ref: "p1", parent_ref: root.id, summary: "Phase 1", properties: { priority: 10 } },
          { ref: "t1", parent_ref: "p1", summary: "Task in P1", properties: { priority: 5 } },
          { ref: "p2", parent_ref: root.id, summary: "Phase 2", properties: { priority: 10 } },
          { ref: "t2", parent_ref: "p2", summary: "Task in P2", properties: { priority: 5 } },
        ],
      },
      AGENT
    );

    const p1Id = plan.created.find((c) => c.ref === "p1")!.id;

    // Without scope: returns highest priority actionable (could be from either phase)
    const all = handleNext({ project: "test", count: 10 }, AGENT);
    expect(all.nodes.length).toBeGreaterThanOrEqual(2);

    // With scope: only returns tasks under Phase 1
    const scoped = handleNext({ project: "test", scope: p1Id }, AGENT);
    expect(scoped.nodes).toHaveLength(1);
    expect(scoped.nodes[0].node.summary).toBe("Task in P1");
  });

  it("returns empty when scope has no actionable descendants", () => {
    const { root } = openProject("test", "test", AGENT) as any;

    const plan = handlePlan(
      {
        nodes: [
          { ref: "p1", parent_ref: root.id, summary: "Phase 1" },
          { ref: "t1", parent_ref: "p1", summary: "Task", depends_on: ["p1"] },
        ],
      },
      AGENT
    );

    // t1 depends on p1 which is unresolved — nothing actionable under p1
    // actually p1 has an unresolved child, so it's not a leaf. t1 is blocked.
    const p1Id = plan.created.find((c) => c.ref === "p1")!.id;
    const scoped = handleNext({ project: "test", scope: p1Id }, AGENT);
    expect(scoped.nodes).toHaveLength(0);
  });

  it("soft-claims when requested", () => {
    const { root } = openProject("test", "test", AGENT) as any;
    handlePlan({ nodes: [{ ref: "a", parent_ref: root.id, summary: "Task" }] }, AGENT);

    const result = handleNext({ project: "test", claim: true }, AGENT);
    expect(result.nodes[0].node.properties._claimed_by).toBe(AGENT);
  });
});

describe("graph_context", () => {
  it("returns full neighborhood", () => {
    const { root } = openProject("test", "test", AGENT) as any;

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
    const { root } = openProject("test", "test", AGENT) as any;

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
    const { root } = openProject("test", "test", AGENT) as any;
    handlePlan({ nodes: [{ ref: "a", parent_ref: root.id, summary: "A" }] }, AGENT);
    const query = handleQuery({ project: "test", filter: { is_actionable: true } });
    const nodeId = query.nodes[0].id;

    expect(() =>
      handleUpdate({ updates: [{ node_id: nodeId, resolved: true }] }, AGENT)
    ).toThrow(EngineError);
  });

  it("allows resolve with evidence", () => {
    const { root } = openProject("test", "test", AGENT) as any;
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
    const { root } = openProject("test", "test", AGENT) as any;
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
    const { root } = openProject("test", "test", AGENT) as any;
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
    const { root } = openProject("test", "test", AGENT) as any;
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
    const { root } = openProject("test", "test", AGENT) as any;
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
    const { root } = openProject("test", "test", AGENT) as any;
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
    const { root } = openProject("test", "test", AGENT) as any;
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

  it("merges two nodes, transfers children and edges", () => {
    const { root } = openProject("test", "test", AGENT) as any;
    const plan = handlePlan(
      {
        nodes: [
          { ref: "source", parent_ref: root.id, summary: "Source" },
          { ref: "target", parent_ref: root.id, summary: "Target" },
          { ref: "child", parent_ref: "source", summary: "Source Child" },
          { ref: "dep", parent_ref: root.id, summary: "Dependency" },
          { ref: "waiter", parent_ref: root.id, summary: "Waiter", depends_on: ["source"] },
        ],
      },
      AGENT
    );

    const sourceId = plan.created.find((c) => c.ref === "source")!.id;
    const targetId = plan.created.find((c) => c.ref === "target")!.id;
    const childId = plan.created.find((c) => c.ref === "child")!.id;

    const result = handleRestructure(
      { operations: [{ op: "merge", source: sourceId, target: targetId }] },
      AGENT
    );

    expect(result.applied).toBe(1);

    // Child should now be under target
    const ctx = handleContext({ node_id: targetId });
    expect(ctx.children.children!.some((c) => c.id === childId)).toBe(true);

    // Waiter should now depend on target (edge transferred)
    const waiterCtx = handleContext({ node_id: plan.created.find((c) => c.ref === "waiter")!.id });
    expect(waiterCtx.depends_on.some((d) => d.node.id === targetId)).toBe(true);

    // Source should be deleted
    expect(() => handleContext({ node_id: sourceId })).toThrow();
  });

  it("deletes a node and its subtree", () => {
    const { root } = openProject("del-test", "test", AGENT) as any;
    const plan = handlePlan(
      {
        nodes: [
          { ref: "keep", parent_ref: root.id, summary: "Keep" },
          { ref: "delete-me", parent_ref: root.id, summary: "Delete Me" },
          { ref: "child", parent_ref: "delete-me", summary: "Child of Delete" },
        ],
      },
      AGENT
    );

    const deleteId = plan.created.find((c) => c.ref === "delete-me")!.id;

    const result = handleRestructure(
      { operations: [{ op: "delete", node_id: deleteId }] },
      AGENT
    );

    expect(result.applied).toBe(1);

    // Deleted nodes should be gone
    expect(() => handleContext({ node_id: deleteId })).toThrow();

    // Keep node should still exist
    const keepId = plan.created.find((c) => c.ref === "keep")!.id;
    const ctx = handleContext({ node_id: keepId });
    expect(ctx.node.summary).toBe("Keep");
  });

  it("drops a subtree", () => {
    const { root } = openProject("test", "test", AGENT) as any;
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

    const summary = openProject("test", "test", AGENT) as any;
    expect(summary.summary.resolved).toBe(2); // A + A.1 resolved, root stays unresolved
  });
});

describe("graph_history", () => {
  it("returns audit trail", () => {
    const { root } = openProject("test", "test", AGENT) as any;
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

describe("graph_onboard", () => {
  it("returns all five sections for a project", () => {
    const { root } = openProject("test", "Build app", AGENT) as any;

    // Create a tree with some resolved work and evidence
    const plan = handlePlan(
      {
        nodes: [
          { ref: "phase1", parent_ref: root.id, summary: "Phase 1", context_links: ["src/db.ts"] },
          { ref: "task1", parent_ref: "phase1", summary: "Setup DB", properties: { priority: 10 } },
          { ref: "task2", parent_ref: "phase1", summary: "Add migrations", depends_on: ["task1"], properties: { priority: 5 } },
          { ref: "phase2", parent_ref: root.id, summary: "Phase 2" },
          { ref: "task3", parent_ref: "phase2", summary: "Build API", context_links: ["src/api.ts"] },
        ],
      },
      AGENT
    );

    // Resolve task1 with evidence
    const task1Id = plan.created.find((c) => c.ref === "task1")!.id;
    handleUpdate(
      {
        updates: [
          {
            node_id: task1Id,
            resolved: true,
            add_evidence: [
              { type: "note", ref: "Created SQLite schema with WAL mode" },
              { type: "git", ref: "abc123 — initial schema" },
            ],
          },
        ],
      },
      AGENT
    );

    const result = handleOnboard({ project: "test" });

    // 1. Summary
    expect(result.summary.total).toBe(6); // root + 2 phases + 3 tasks
    expect(result.summary.resolved).toBe(1);
    expect(result.summary.actionable).toBe(2); // task2 (unblocked), task3

    // 2. Tree — should show root's direct children with their children
    expect(result.tree).toHaveLength(2);
    expect(result.tree[0].summary).toBe("Phase 1");
    expect(result.tree[0].children).toHaveLength(2);
    expect(result.tree[1].summary).toBe("Phase 2");

    // 3. Recent evidence — should include evidence from resolved task1
    expect(result.recent_evidence.length).toBeGreaterThanOrEqual(2);
    expect(result.recent_evidence.some((e) => e.type === "git")).toBe(true);
    expect(result.recent_evidence.some((e) => e.type === "note")).toBe(true);
    expect(result.recent_evidence[0].node_summary).toBe("Setup DB");

    // 4. Context links — aggregated and deduplicated
    expect(result.context_links).toContain("src/db.ts");
    expect(result.context_links).toContain("src/api.ts");

    // 5. Actionable
    expect(result.actionable.length).toBeGreaterThanOrEqual(2);
  });

  it("throws for nonexistent project", () => {
    expect(() => handleOnboard({ project: "nope" })).toThrow(EngineError);
  });

  it("includes knowledge entries", () => {
    openProject("test", "Build app", AGENT);

    // Write some knowledge
    handleKnowledgeWrite({ project: "test", key: "architecture", content: "Monorepo with pnpm workspaces" }, AGENT);
    handleKnowledgeWrite({ project: "test", key: "conventions", content: "Use kebab-case for file names" }, AGENT);

    const result = handleOnboard({ project: "test" });
    expect(result.knowledge).toHaveLength(2);
    expect(result.knowledge.map((k) => k.key).sort()).toEqual(["architecture", "conventions"]);
    expect(result.knowledge[0].content).toBeDefined();
    expect(result.knowledge[0].updated_at).toBeDefined();
  });

  it("returns empty knowledge array when none exist", () => {
    openProject("test", "Build app", AGENT);

    const result = handleOnboard({ project: "test" });
    expect(result.knowledge).toEqual([]);
  });

  it("surfaces root discovery status and hint for new project", () => {
    // Don't use openProject helper — we want discovery:pending
    handleOpen({ project: "fresh", goal: "A brand new project" }, AGENT);

    const result = handleOnboard({ project: "fresh" });
    expect(result.goal).toBe("A brand new project");
    expect(result.discovery).toBe("pending");
    expect(result.hint).toContain("Discovery is pending");
  });

  it("shows actionable hint when tasks are ready", () => {
    openProject("ready", "Ready project", AGENT);
    const { root } = handleOpen({ project: "ready" }, AGENT) as any;
    handlePlan({ nodes: [{ ref: "a", parent_ref: root.id, summary: "Task" }] }, AGENT);

    const result = handleOnboard({ project: "ready" });
    expect(result.discovery).toBe("done");
    expect(result.hint).toContain("actionable");
    expect(result.hint).toContain("graph_next");
  });

  it("shows recently resolved tasks and last_activity for returning agents", () => {
    const { root } = openProject("returning", "Returning project", AGENT) as any;
    const plan = handlePlan({
      nodes: [
        { ref: "done", parent_ref: root.id, summary: "Completed task" },
        { ref: "todo", parent_ref: root.id, summary: "Pending task" },
      ],
    }, AGENT);

    const doneId = plan.created.find((c: any) => c.ref === "done")!.id;
    handleUpdate({
      updates: [{ node_id: doneId, resolved: true, add_evidence: [{ type: "note", ref: "finished" }] }],
    }, AGENT);

    const result = handleOnboard({ project: "returning" });
    expect(result.recently_resolved.length).toBeGreaterThanOrEqual(1);
    expect(result.recently_resolved[0].summary).toBe("Completed task");
    expect(result.recently_resolved[0].agent).toBe(AGENT);
    expect(result.last_activity).toBeDefined();
    expect(result.hint).toContain("resolved recently");
  });

  it("respects evidence_limit", () => {
    const { root } = openProject("test", "Goal", AGENT) as any;
    const plan = handlePlan(
      { nodes: [{ ref: "a", parent_ref: root.id, summary: "A" }] },
      AGENT
    );

    const nodeId = plan.created[0].id;
    handleUpdate(
      {
        updates: [
          {
            node_id: nodeId,
            resolved: true,
            add_evidence: [
              { type: "note", ref: "ev1" },
              { type: "note", ref: "ev2" },
              { type: "note", ref: "ev3" },
            ],
          },
        ],
      },
      AGENT
    );

    const result = handleOnboard({ project: "test", evidence_limit: 2 });
    expect(result.recent_evidence).toHaveLength(2);
  });
});

describe("graph_onboard checklist", () => {
  it("returns all 5 checks as pass for a healthy project", () => {
    const { root } = openProject("healthy", "Healthy project", AGENT) as any;
    const plan = handlePlan({
      nodes: [
        { ref: "t1", parent_ref: root.id, summary: "Task 1" },
        { ref: "t2", parent_ref: root.id, summary: "Task 2" },
      ],
    }, AGENT);

    // Resolve one task with evidence
    const t1Id = plan.created.find((c: any) => c.ref === "t1")!.id;
    handleUpdate({
      updates: [{ node_id: t1Id, resolved: true, add_evidence: [{ type: "note", ref: "Done" }] }],
    }, AGENT);

    // Add knowledge
    handleKnowledgeWrite({ project: "healthy", key: "arch", content: "Architecture notes" }, AGENT);

    const result = handleOnboard({ project: "healthy" }) as any;
    expect(result.checklist).toHaveLength(6);
    const checks = result.checklist.map((c: any) => c.check);
    expect(checks).toEqual(["review_evidence", "review_knowledge", "confirm_blockers", "check_stale", "resolve_claimed", "plan_next_actions"]);
    // All should pass for a healthy project
    for (const item of result.checklist) {
      expect(item.status).toBe("pass");
    }
  });

  it("flags missing evidence as action_required on mature projects", () => {
    const { root } = openProject("no-ev", "No evidence project", AGENT) as any;

    // Create and resolve 5+ tasks without evidence (need to bypass evidence requirement)
    // Actually, resolving requires evidence. So create tasks and resolve with evidence,
    // then clear evidence directly in DB to simulate the condition.
    const refs = ["a", "b", "c", "d", "e"];
    const plan = handlePlan({
      nodes: refs.map((r) => ({ ref: r, parent_ref: root.id, summary: `Task ${r}` })),
    }, AGENT);

    for (const created of plan.created) {
      handleUpdate({
        updates: [{ node_id: created.id, resolved: true, add_evidence: [{ type: "note", ref: "done" }] }],
      }, AGENT);
    }

    // Clear all evidence directly to simulate missing evidence (include root in case it auto-resolved)
    const db = getDb();
    db.prepare("UPDATE nodes SET evidence = '[]' WHERE project = ?").run("no-ev");

    const result = handleOnboard({ project: "no-ev" }) as any;
    const evCheck = result.checklist.find((c: any) => c.check === "review_evidence");
    expect(evCheck.status).toBe("action_required");
    expect(evCheck.message).toContain("resolved task(s) exist but none have evidence");
  });

  it("flags blocked items as action_required", () => {
    const { root } = openProject("blocked", "Blocked project", AGENT) as any;
    const plan = handlePlan({
      nodes: [
        { ref: "t1", parent_ref: root.id, summary: "Blocked task" },
        { ref: "t2", parent_ref: root.id, summary: "Free task" },
      ],
    }, AGENT);

    const t1Id = plan.created.find((c: any) => c.ref === "t1")!.id;
    handleUpdate({
      updates: [{ node_id: t1Id, blocked: true, blocked_reason: "Waiting on API key" }],
    }, AGENT);

    const result = handleOnboard({ project: "blocked" }) as any;
    const blockerCheck = result.checklist.find((c: any) => c.check === "confirm_blockers");
    expect(blockerCheck.status).toBe("action_required");
    expect(blockerCheck.message).toContain("1 blocked");
  });

  it("flags stale tasks as warn", () => {
    const { root } = openProject("stale", "Stale project", AGENT) as any;
    handlePlan({
      nodes: [{ ref: "old", parent_ref: root.id, summary: "Old task" }],
    }, AGENT);

    // Backdate the task to 10 days ago
    const db = getDb();
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare("UPDATE nodes SET updated_at = ? WHERE project = ? AND parent IS NOT NULL").run(tenDaysAgo, "stale");

    const result = handleOnboard({ project: "stale" }) as any;
    const staleCheck = result.checklist.find((c: any) => c.check === "check_stale");
    expect(staleCheck.status).toBe("warn");
    expect(staleCheck.message).toContain("not updated in 7+ days");
  });

  it("flags missing knowledge on mature project as warn", () => {
    const { root } = openProject("mature", "Mature project", AGENT) as any;

    // Create and resolve 5 tasks with evidence (no knowledge)
    const refs = ["a", "b", "c", "d", "e"];
    const plan = handlePlan({
      nodes: refs.map((r) => ({ ref: r, parent_ref: root.id, summary: `Task ${r}` })),
    }, AGENT);

    for (const created of plan.created) {
      handleUpdate({
        updates: [{ node_id: created.id, resolved: true, add_evidence: [{ type: "note", ref: "done" }] }],
      }, AGENT);
    }

    const result = handleOnboard({ project: "mature" }) as any;
    const knowledgeCheck = result.checklist.find((c: any) => c.check === "review_knowledge");
    expect(knowledgeCheck.status).toBe("warn");
    expect(knowledgeCheck.message).toContain("Mature project");
  });

  it("strict mode prepends warning to hint when action items exist", () => {
    const { root } = openProject("strict", "Strict project", AGENT) as any;
    const plan = handlePlan({
      nodes: [{ ref: "t1", parent_ref: root.id, summary: "Blocked task" }],
    }, AGENT);

    const t1Id = plan.created.find((c: any) => c.ref === "t1")!.id;
    handleUpdate({
      updates: [{ node_id: t1Id, blocked: true, blocked_reason: "Waiting" }],
    }, AGENT);

    // Without strict — no warning prefix
    const normal = handleOnboard({ project: "strict" }) as any;
    expect(normal.hint).not.toContain("Rehydrate checklist");

    // With strict — warning prefix present
    const strictResult = handleOnboard({ project: "strict", strict: true }) as any;
    expect(strictResult.hint).toContain("Rehydrate checklist has action items");
  });

  it("flags claimed-but-unresolved nodes as action_required", () => {
    const { root } = openProject("claimed", "Claimed project", AGENT) as any;
    const plan = handlePlan({
      nodes: [{ ref: "t1", parent_ref: root.id, summary: "Claimed task" }],
    }, AGENT);

    // Claim the task via graph_next
    handleNext({ project: "claimed", claim: true }, AGENT, 60);

    const result = handleOnboard({ project: "claimed" }) as any;
    const claimCheck = result.checklist.find((c: any) => c.check === "resolve_claimed");
    expect(claimCheck.status).toBe("action_required");
    expect(claimCheck.message).toContain("1 claimed");
  });

  it("passes resolve_claimed when claimed node is resolved", () => {
    const { root } = openProject("resolved-claim", "Resolved claim", AGENT) as any;
    const plan = handlePlan({
      nodes: [{ ref: "t1", parent_ref: root.id, summary: "Task" }],
    }, AGENT);

    // Claim and resolve
    const next = handleNext({ project: "resolved-claim", claim: true }, AGENT, 60);
    const taskId = next.nodes[0].node.id;
    handleUpdate({
      updates: [{ node_id: taskId, resolved: true, add_evidence: [{ type: "note", ref: "Done" }] }],
    }, AGENT);

    const result = handleOnboard({ project: "resolved-claim" }) as any;
    const claimCheck = result.checklist.find((c: any) => c.check === "resolve_claimed");
    expect(claimCheck.status).toBe("pass");
  });

  it("empty project checklist is sensible (no false alarms)", () => {
    openProject("empty", "Empty project", AGENT);

    const result = handleOnboard({ project: "empty" }) as any;
    expect(result.checklist).toHaveLength(6);
    // No action_required on an empty project
    const actionRequired = result.checklist.filter((c: any) => c.status === "action_required");
    expect(actionRequired).toHaveLength(0);
  });
});

describe("graph_agent_config", () => {
  it("returns agent file content for all tiers (free retention hook)", () => {
    const result = handleAgentConfig("1.2.3");
    expect(result.agent_file).toContain("graph-optimized agent");
    expect(result.install_path).toBe(".claude/agents/graph.md");
    expect(result.instructions).toContain("Save the agent_file");
  });

  it("embeds version in YAML frontmatter", () => {
    const result = handleAgentConfig("0.1.12");
    const match = result.agent_file.match(/^---[\s\S]*?version:\s*(\S+)[\s\S]*?---/);
    expect(match).not.toBeNull();
    expect(match![1]).toBe("0.1.12");
  });
});

describe("full workflow", () => {
  it("plan -> claim -> work -> resolve -> unblock", () => {
    // Open project
    const { root } = openProject("workflow", "Build feature", AGENT) as any;

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

describe("graph_knowledge", () => {
  it("writes and reads a knowledge entry", () => {
    handleOpen({ project: "kb-test", goal: "Test knowledge" }, AGENT);

    const writeResult = handleKnowledgeWrite(
      { project: "kb-test", key: "arch", content: "Monorepo with turborepo" },
      AGENT
    );
    expect(writeResult.action).toBe("created");

    const readResult = handleKnowledgeRead({ project: "kb-test", key: "arch" }) as any;
    expect(readResult.key).toBe("arch");
    expect(readResult.content).toBe("Monorepo with turborepo");
  });

  it("overwrites existing key", () => {
    handleOpen({ project: "kb-test", goal: "Test knowledge" }, AGENT);

    handleKnowledgeWrite({ project: "kb-test", key: "db", content: "PostgreSQL" }, AGENT);
    const update = handleKnowledgeWrite({ project: "kb-test", key: "db", content: "SQLite" }, AGENT);
    expect(update.action).toBe("updated");

    const read = handleKnowledgeRead({ project: "kb-test", key: "db" }) as any;
    expect(read.content).toBe("SQLite");
  });

  it("lists all entries when key omitted", () => {
    handleOpen({ project: "kb-test", goal: "Test knowledge" }, AGENT);

    handleKnowledgeWrite({ project: "kb-test", key: "arch", content: "Monorepo" }, AGENT);
    handleKnowledgeWrite({ project: "kb-test", key: "conventions", content: "Use kebab-case" }, AGENT);

    const list = handleKnowledgeRead({ project: "kb-test" }) as any;
    expect(list.entries).toHaveLength(2);
  });

  it("searches by substring", () => {
    handleOpen({ project: "kb-test", goal: "Test knowledge" }, AGENT);

    handleKnowledgeWrite({ project: "kb-test", key: "auth", content: "JWT with refresh tokens" }, AGENT);
    handleKnowledgeWrite({ project: "kb-test", key: "db", content: "PostgreSQL with prisma" }, AGENT);

    const results = handleKnowledgeSearch({ project: "kb-test", query: "JWT" }) as any;
    expect(results.entries).toHaveLength(1);
    expect(results.entries[0].key).toBe("auth");
  });

  it("throws for non-existent project", () => {
    expect(() => handleKnowledgeWrite({ project: "nope", key: "k", content: "v" }, AGENT))
      .toThrow("not found");
  });

  it("throws for non-existent key", () => {
    handleOpen({ project: "kb-test", goal: "Test knowledge" }, AGENT);
    expect(() => handleKnowledgeRead({ project: "kb-test", key: "missing" }))
      .toThrow("not found");
  });

  it("preserves created_by on overwrite", () => {
    handleOpen({ project: "kb-test", goal: "Test knowledge" }, "agent-a");
    handleKnowledgeWrite({ project: "kb-test", key: "arch", content: "v1" }, "agent-a");
    handleKnowledgeWrite({ project: "kb-test", key: "arch", content: "v2" }, "agent-b");

    const read = handleKnowledgeRead({ project: "kb-test", key: "arch" }) as any;
    expect(read.content).toBe("v2");
    expect(read.created_by).toBe("agent-a");
  });

  it("deletes an entry", () => {
    handleOpen({ project: "kb-test", goal: "Test knowledge" }, AGENT);
    handleKnowledgeWrite({ project: "kb-test", key: "temp", content: "data" }, AGENT);

    const del = handleKnowledgeDelete({ project: "kb-test", key: "temp" });
    expect(del.action).toBe("deleted");

    expect(() => handleKnowledgeRead({ project: "kb-test", key: "temp" }))
      .toThrow("not found");
  });

  it("throws when deleting non-existent key", () => {
    handleOpen({ project: "kb-test", goal: "Test knowledge" }, AGENT);
    expect(() => handleKnowledgeDelete({ project: "kb-test", key: "nope" }))
      .toThrow("not found");
  });
});

describe("graph_tree", () => {
  it("returns full tree for a project", () => {
    const { root } = openProject("tree-test", "Build app", AGENT) as any;
    handlePlan({
      nodes: [
        { ref: "design", parent_ref: root.id, summary: "Design" },
        { ref: "api-spec", parent_ref: "design", summary: "API spec" },
        { ref: "impl", parent_ref: root.id, summary: "Implementation" },
        { ref: "auth", parent_ref: "impl", summary: "Auth module" },
        { ref: "routes", parent_ref: "impl", summary: "Routes" },
      ],
    }, AGENT);

    const result = handleTree({ project: "tree-test" });
    expect(result.project).toBe("tree-test");
    expect(result.tree.summary).toBe("Build app");
    expect(result.tree.children).toHaveLength(2);
    // Design has 1 child (API spec)
    const design = result.tree.children!.find((c) => c.summary === "Design");
    expect(design!.children).toHaveLength(1);
    expect(design!.children![0].summary).toBe("API spec");
    // Implementation has 2 children
    const impl = result.tree.children!.find((c) => c.summary === "Implementation");
    expect(impl!.children).toHaveLength(2);
  });

  it("counts resolved vs unresolved", () => {
    const { root } = openProject("tree-test", "Build app", AGENT) as any;
    const plan = handlePlan({
      nodes: [
        { ref: "a", parent_ref: root.id, summary: "Task A" },
        { ref: "b", parent_ref: root.id, summary: "Task B" },
      ],
    }, AGENT);

    const taskA = plan.created.find((c) => c.ref === "a")!.id;
    handleUpdate({ updates: [{ node_id: taskA, resolved: true, add_evidence: [{ type: "note", ref: "done" }] }] }, AGENT);

    const result = handleTree({ project: "tree-test" });
    expect(result.stats.total).toBe(3); // root + 2 tasks
    expect(result.stats.resolved).toBe(1);
    expect(result.stats.unresolved).toBe(2);
  });

  it("respects depth limit", () => {
    const { root } = openProject("tree-test", "Build app", AGENT) as any;
    handlePlan({
      nodes: [
        { ref: "a", parent_ref: root.id, summary: "Level 1" },
        { ref: "b", parent_ref: "a", summary: "Level 2" },
        { ref: "c", parent_ref: "b", summary: "Level 3" },
      ],
    }, AGENT);

    // Depth 2: root (0) -> Level 1 (1) -> Level 2 shows child_count
    const result = handleTree({ project: "tree-test", depth: 2 });
    const lvl1 = result.tree.children![0];
    expect(lvl1.summary).toBe("Level 1");
    expect(lvl1.children![0].summary).toBe("Level 2");
    expect(lvl1.children![0].child_count).toBe(1);
    expect(lvl1.children![0].children).toBeUndefined();
  });

  it("throws for non-existent project", () => {
    expect(() => handleTree({ project: "nope" })).toThrow(EngineError);
  });
});

describe("graph_onboard without project", () => {
  it("auto-selects when only one project exists", () => {
    openProject("solo", "Only project", AGENT);

    const result = handleOnboard({}) as any;
    expect(result.project).toBe("solo");
    expect(result.goal).toBe("Only project");
  });

  it("returns project list when multiple projects exist", () => {
    openProject("proj-a", "Project A", AGENT);
    openProject("proj-b", "Project B", AGENT);

    const result = handleOnboard({}) as any;
    expect(result.projects).toHaveLength(2);
    expect(result.hint).toContain("2 projects found");
  });

  it("returns empty guidance when no projects exist", () => {
    const result = handleOnboard({}) as any;
    expect(result.projects).toEqual([]);
    expect(result.hint).toContain("No projects yet");
  });
});

describe("resolved_reason shorthand", () => {
  it("auto-creates note evidence from resolved_reason", () => {
    const { root } = openProject("rr", "Test", AGENT) as any;
    const plan = handlePlan({ nodes: [{ ref: "a", parent_ref: root.id, summary: "Task" }] }, AGENT);
    const id = plan.created[0].id;

    handleUpdate({
      updates: [{ node_id: id, resolved: true, resolved_reason: "Imported from Jira" }],
    }, AGENT);

    const ctx = handleContext({ node_id: id });
    expect(ctx.node.resolved).toBe(true);
    expect(ctx.node.evidence).toHaveLength(1);
    expect(ctx.node.evidence[0].type).toBe("note");
    expect(ctx.node.evidence[0].ref).toBe("Imported from Jira");
  });

  it("combines resolved_reason with explicit add_evidence", () => {
    const { root } = openProject("rr2", "Test", AGENT) as any;
    const plan = handlePlan({ nodes: [{ ref: "a", parent_ref: root.id, summary: "Task" }] }, AGENT);
    const id = plan.created[0].id;

    handleUpdate({
      updates: [{
        node_id: id,
        resolved: true,
        resolved_reason: "Quick note",
        add_evidence: [{ type: "git", ref: "abc123" }],
      }],
    }, AGENT);

    const ctx = handleContext({ node_id: id });
    expect(ctx.node.evidence).toHaveLength(2);
    expect(ctx.node.evidence.some((e) => e.type === "git")).toBe(true);
    expect(ctx.node.evidence.some((e) => e.ref === "Quick note")).toBe(true);
  });
});

describe("multi-project newly_actionable", () => {
  it("reports newly actionable from all projects when resolving across projects", () => {
    const { root: rootA } = openProject("proj-a", "Project A", AGENT) as any;
    const { root: rootB } = openProject("proj-b", "Project B", AGENT) as any;

    const planA = handlePlan({ nodes: [
      { ref: "blocker", parent_ref: rootA.id, summary: "Blocker A" },
      { ref: "waiting", parent_ref: rootA.id, summary: "Waiting A", depends_on: ["blocker"] },
    ] }, AGENT);

    const planB = handlePlan({ nodes: [
      { ref: "blocker", parent_ref: rootB.id, summary: "Blocker B" },
      { ref: "waiting", parent_ref: rootB.id, summary: "Waiting B", depends_on: ["blocker"] },
    ] }, AGENT);

    const blockerA = planA.created.find((c) => c.ref === "blocker")!.id;
    const blockerB = planB.created.find((c) => c.ref === "blocker")!.id;

    // Resolve both blockers in a single update call
    const result = handleUpdate({
      updates: [
        { node_id: blockerA, resolved: true, resolved_reason: "done" },
        { node_id: blockerB, resolved: true, resolved_reason: "done" },
      ],
    }, AGENT);

    // Should report newly actionable from BOTH projects
    expect(result.newly_actionable).toBeDefined();
    expect(result.newly_actionable!.some((n) => n.summary === "Waiting A")).toBe(true);
    expect(result.newly_actionable!.some((n) => n.summary === "Waiting B")).toBe(true);
  });
});

describe("optimistic concurrency (expected_rev)", () => {
  it("accepts update when rev matches", () => {
    const { root } = openProject("occ", "Test", AGENT) as any;
    const plan = handlePlan({ nodes: [{ ref: "a", parent_ref: root.id, summary: "Task" }] }, AGENT);
    const id = plan.created[0].id;

    // Node starts at rev 1
    handleUpdate({
      updates: [{ node_id: id, expected_rev: 1, summary: "Updated" }],
    }, AGENT);

    const ctx = handleContext({ node_id: id });
    expect(ctx.node.summary).toBe("Updated");
    expect(ctx.node.rev).toBe(2);
  });

  it("rejects update when rev does not match", () => {
    const { root } = openProject("occ2", "Test", AGENT) as any;
    const plan = handlePlan({ nodes: [{ ref: "a", parent_ref: root.id, summary: "Task" }] }, AGENT);
    const id = plan.created[0].id;

    expect(() => handleUpdate({
      updates: [{ node_id: id, expected_rev: 99, summary: "Stale" }],
    }, AGENT)).toThrow("expected 99");
  });
});

describe("cross-project restructure guard", () => {
  it("rejects move across projects", () => {
    const { root: rootA } = openProject("cp-a", "A", AGENT) as any;
    const { root: rootB } = openProject("cp-b", "B", AGENT) as any;
    const plan = handlePlan({ nodes: [{ ref: "child", parent_ref: rootA.id, summary: "Child" }] }, AGENT);
    const childId = plan.created[0].id;

    expect(() => handleRestructure({
      operations: [{ op: "move", node_id: childId, new_parent: rootB.id }],
    }, AGENT)).toThrow("Cannot move node across projects");
  });

  it("rejects merge across projects", () => {
    const { root: rootA } = openProject("cp-a2", "A", AGENT) as any;
    const { root: rootB } = openProject("cp-b2", "B", AGENT) as any;
    const planA = handlePlan({ nodes: [{ ref: "a", parent_ref: rootA.id, summary: "Node A" }] }, AGENT);
    const planB = handlePlan({ nodes: [{ ref: "b", parent_ref: rootB.id, summary: "Node B" }] }, AGENT);

    expect(() => handleRestructure({
      operations: [{ op: "merge", source: planA.created[0].id, target: planB.created[0].id }],
    }, AGENT)).toThrow("Cannot merge nodes across projects");
  });
});

describe("blocked status (#5)", () => {
  it("sets and unsets blocked via graph_update", () => {
    const { root } = openProject("blk", "Test", AGENT) as any;
    const plan = handlePlan({ nodes: [{ ref: "a", parent_ref: root.id, summary: "Task" }] }, AGENT);
    const id = plan.created[0].id;

    // Block
    handleUpdate({ updates: [{ node_id: id, blocked: true, blocked_reason: "Waiting on domain" }] }, AGENT);
    let ctx = handleContext({ node_id: id });
    expect(ctx.node.blocked).toBe(true);
    expect(ctx.node.blocked_reason).toBe("Waiting on domain");

    // Unblock — reason should auto-clear
    handleUpdate({ updates: [{ node_id: id, blocked: false }] }, AGENT);
    ctx = handleContext({ node_id: id });
    expect(ctx.node.blocked).toBe(false);
    expect(ctx.node.blocked_reason).toBeNull();
  });

  it("graph_next skips manually blocked nodes", () => {
    const { root } = openProject("blk-next", "Test", AGENT) as any;
    const plan = handlePlan({
      nodes: [
        { ref: "a", parent_ref: root.id, summary: "Blocked task", properties: { priority: 10 } },
        { ref: "b", parent_ref: root.id, summary: "Available task", properties: { priority: 5 } },
      ],
    }, AGENT);
    const idA = plan.created.find((c) => c.ref === "a")!.id;

    // Block the high-priority task
    handleUpdate({ updates: [{ node_id: idA, blocked: true, blocked_reason: "External dep" }] }, AGENT);

    // graph_next should return the unblocked task
    const next = handleNext({ project: "blk-next" }, AGENT);
    expect(next.nodes).toHaveLength(1);
    expect(next.nodes[0].node.summary).toBe("Available task");
  });

  it("graph_query is_blocked includes manually blocked nodes", () => {
    const { root } = openProject("blk-query", "Test", AGENT) as any;
    const plan = handlePlan({
      nodes: [
        { ref: "manual", parent_ref: root.id, summary: "Manually blocked" },
        { ref: "dep-blocker", parent_ref: root.id, summary: "Blocker" },
        { ref: "dep-blocked", parent_ref: root.id, summary: "Dep blocked", depends_on: ["dep-blocker"] },
        { ref: "free", parent_ref: root.id, summary: "Free task" },
      ],
    }, AGENT);
    const manualId = plan.created.find((c) => c.ref === "manual")!.id;

    handleUpdate({ updates: [{ node_id: manualId, blocked: true, blocked_reason: "Waiting" }] }, AGENT);

    const blocked = handleQuery({ project: "blk-query", filter: { is_blocked: true } });
    expect(blocked.nodes.length).toBe(2); // manual + dep-blocked
    const summaries = blocked.nodes.map((n) => n.summary).sort();
    expect(summaries).toEqual(["Dep blocked", "Manually blocked"]);
  });

  it("graph_query is_actionable excludes manually blocked nodes", () => {
    const { root } = openProject("blk-act", "Test", AGENT) as any;
    const plan = handlePlan({
      nodes: [
        { ref: "a", parent_ref: root.id, summary: "Blocked" },
        { ref: "b", parent_ref: root.id, summary: "Free" },
      ],
    }, AGENT);
    const idA = plan.created.find((c) => c.ref === "a")!.id;

    handleUpdate({ updates: [{ node_id: idA, blocked: true, blocked_reason: "Test block" }] }, AGENT);

    const actionable = handleQuery({ project: "blk-act", filter: { is_actionable: true } });
    expect(actionable.nodes).toHaveLength(1);
    expect(actionable.nodes[0].summary).toBe("Free");
  });

  it("blocked change appears in audit history", () => {
    const { root } = openProject("blk-hist", "Test", AGENT) as any;
    const plan = handlePlan({ nodes: [{ ref: "a", parent_ref: root.id, summary: "Task" }] }, AGENT);
    const id = plan.created[0].id;

    handleUpdate({ updates: [{ node_id: id, blocked: true, blocked_reason: "Reason" }] }, AGENT);

    const history = handleHistory({ node_id: id });
    const blockedEvent = history.events.find((e: any) =>
      e.changes && JSON.stringify(e.changes).includes("blocked")
    );
    expect(blockedEvent).toBeDefined();
  });

  it("blocked nodes count in project summary", () => {
    const { root } = openProject("blk-sum", "Test", AGENT) as any;
    const plan = handlePlan({
      nodes: [
        { ref: "a", parent_ref: root.id, summary: "Blocked" },
        { ref: "b", parent_ref: root.id, summary: "Free" },
      ],
    }, AGENT);
    const idA = plan.created.find((c) => c.ref === "a")!.id;

    handleUpdate({ updates: [{ node_id: idA, blocked: true, blocked_reason: "Test block" }] }, AGENT);

    const summary = handleOpen({ project: "blk-sum" }, AGENT) as any;
    expect(summary.summary.blocked).toBe(1);
    expect(summary.summary.actionable).toBe(1);
  });
});

describe("your_claims in graph_next (#6)", () => {
  it("surfaces existing claims in response", () => {
    const { root } = openProject("claims", "Test", AGENT) as any;
    handlePlan({
      nodes: [
        { ref: "a", parent_ref: root.id, summary: "Task A" },
        { ref: "b", parent_ref: root.id, summary: "Task B" },
      ],
    }, AGENT);

    // Claim task A
    const first = handleNext({ project: "claims", claim: true }, AGENT);
    expect(first.nodes[0].node.summary).toBe("Task A");

    // Next call should show the existing claim
    const second = handleNext({ project: "claims" }, AGENT);
    expect(second.your_claims).toBeDefined();
    expect(second.your_claims).toHaveLength(1);
    expect(second.your_claims![0].summary).toBe("Task A");
    expect(second.your_claims![0].claimed_at).toBeDefined();
  });

  it("does not show claims from other agents", () => {
    const { root } = openProject("claims-other", "Test", AGENT) as any;
    handlePlan({
      nodes: [
        { ref: "a", parent_ref: root.id, summary: "Task A" },
        { ref: "b", parent_ref: root.id, summary: "Task B" },
      ],
    }, AGENT);

    // Agent 1 claims task A
    handleNext({ project: "claims-other", claim: true }, "agent-1");

    // Agent 2 should not see agent-1's claims
    const result = handleNext({ project: "claims-other" }, "agent-2");
    expect(result.your_claims).toBeUndefined();
  });

  it("excludes expired claims", () => {
    const { root } = openProject("claims-exp", "Test", AGENT) as any;
    const plan = handlePlan({
      nodes: [{ ref: "a", parent_ref: root.id, summary: "Task" }],
    }, AGENT);
    const id = plan.created[0].id;

    // Manually set a claim with an old timestamp (well past TTL)
    updateNode({
      node_id: id,
      agent: AGENT,
      properties: {
        _claimed_by: AGENT,
        _claimed_at: "2020-01-01T00:00:00.000Z",
      },
    });

    // Expired claim should not appear
    const result = handleNext({ project: "claims-exp" }, AGENT);
    expect(result.your_claims).toBeUndefined();
  });

  it("omits your_claims when none exist", () => {
    const { root } = openProject("claims-none", "Test", AGENT) as any;
    handlePlan({
      nodes: [{ ref: "a", parent_ref: root.id, summary: "Task" }],
    }, AGENT);

    const result = handleNext({ project: "claims-none" }, AGENT);
    expect(result.your_claims).toBeUndefined();
  });
});

// [sl:gHxxmjJq9GhDpwsAdnFRx] Cross-project edge validation
describe("cross-project edge rejection", () => {
  it("rejects edges between nodes in different projects", () => {
    const { root: root1 } = openProject("proj-a", "Project A", AGENT) as any;
    const { root: root2 } = openProject("proj-b", "Project B", AGENT) as any;
    const plan1 = handlePlan({ nodes: [{ ref: "a", parent_ref: root1.id, summary: "Task A" }] }, AGENT);
    const plan2 = handlePlan({ nodes: [{ ref: "b", parent_ref: root2.id, summary: "Task B" }] }, AGENT);

    const result = handleConnect({
      edges: [{ from: plan1.created[0].id, to: plan2.created[0].id, type: "depends_on" }],
    }, AGENT);

    expect(result.applied).toBe(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected![0].reason).toContain("cross_project_edge");
  });

  it("allows edges within the same project", () => {
    const { root } = openProject("proj-same", "Project", AGENT) as any;
    const plan = handlePlan({
      nodes: [
        { ref: "a", parent_ref: root.id, summary: "Task A" },
        { ref: "b", parent_ref: root.id, summary: "Task B" },
      ],
    }, AGENT);

    const result = handleConnect({
      edges: [{ from: plan.created[0].id, to: plan.created[1].id, type: "depends_on" }],
    }, AGENT);

    expect(result.applied).toBe(1);
    expect(result.rejected).toBeUndefined();
  });
});

// [sl:k2dMFzFIn-gK_A9KjK6-D] Batch update transaction
describe("graph_update transaction safety", () => {
  it("rolls back all updates when one fails", () => {
    const { root } = openProject("tx-update", "Test", AGENT) as any;
    const plan = handlePlan({
      nodes: [
        { ref: "a", parent_ref: root.id, summary: "Task A" },
        { ref: "b", parent_ref: root.id, summary: "Task B" },
      ],
    }, AGENT);

    const idA = plan.created[0].id;
    const idB = plan.created[1].id;

    // Update A successfully, but B with wrong expected_rev should fail
    expect(() => handleUpdate({
      updates: [
        { node_id: idA, summary: "Updated A" },
        { node_id: idB, summary: "Updated B", expected_rev: 999 },
      ],
    }, AGENT)).toThrow();

    // A should NOT have been updated (transaction rolled back)
    const nodeA = handleContext({ node_id: idA });
    expect(nodeA.node.summary).toBe("Task A");
  });
});

// [sl:8UOMOgVDsAynQMHhq9d_i] Query depth sort and cursor
describe("graph_query sort and cursor fixes", () => {
  it("sorts by depth ascending", () => {
    const { root } = openProject("qsort-depth", "Test", AGENT) as any;
    handlePlan({
      nodes: [
        { ref: "phase", parent_ref: root.id, summary: "Phase" },
        { ref: "task", parent_ref: "phase", summary: "Deep task" },
      ],
    }, AGENT);

    const result = handleQuery({ project: "qsort-depth", sort: "depth" });
    const depths = result.nodes.map(n => n.depth);
    // Should be ascending
    for (let i = 1; i < depths.length; i++) {
      expect(depths[i]).toBeGreaterThanOrEqual(depths[i - 1]);
    }
  });

  it("cursor works with recent sort", () => {
    const { root } = openProject("qsort-recent", "Test", AGENT) as any;
    handlePlan({
      nodes: [
        { ref: "a", parent_ref: root.id, summary: "Task A" },
        { ref: "b", parent_ref: root.id, summary: "Task B" },
        { ref: "c", parent_ref: root.id, summary: "Task C" },
      ],
    }, AGENT);

    // Fetch page 1 with limit 2
    const page1 = handleQuery({ project: "qsort-recent", sort: "recent", limit: 2 });
    expect(page1.nodes).toHaveLength(2);
    expect(page1.next_cursor).toBeDefined();

    // Fetch page 2 with cursor
    const page2 = handleQuery({ project: "qsort-recent", sort: "recent", limit: 2, cursor: page1.next_cursor });
    expect(page2.nodes.length).toBeGreaterThan(0);

    // No overlap between pages
    const page1Ids = new Set(page1.nodes.map(n => n.id));
    for (const n of page2.nodes) {
      expect(page1Ids.has(n.id)).toBe(false);
    }
  });
});

// [sl:Ufz48Frf4aeXz9ztEODKE] Auto-scope graph_next to active subtree
describe("auto-scope graph_next", () => {
  it("auto-scopes to parent of most recent claim", () => {
    const { root } = openProject("autoscope", "Test", AGENT) as any;
    const plan = handlePlan({
      nodes: [
        { ref: "phase1", parent_ref: root.id, summary: "Phase 1" },
        { ref: "a", parent_ref: "phase1", summary: "Task A" },
        { ref: "b", parent_ref: "phase1", summary: "Task B" },
        { ref: "phase2", parent_ref: root.id, summary: "Phase 2" },
        { ref: "c", parent_ref: "phase2", summary: "Task C" },
      ],
    }, AGENT);

    // Claim Task A (under Phase 1)
    const first = handleNext({ project: "autoscope", claim: true }, AGENT);
    expect(first.nodes[0].node.summary).toBe("Task A");

    // Resolve Task A
    handleUpdate({ updates: [{ node_id: first.nodes[0].node.id, resolved: true, resolved_reason: "Done" }] }, AGENT);

    // Next call should auto-scope to Phase 1 (parent of claimed Task A)
    const second = handleNext({ project: "autoscope" }, AGENT);
    expect(second.auto_scoped).toBeDefined();
    expect(second.auto_scoped!.parent_summary).toBe("Phase 1");
    // Should return Task B (same subtree), not Task C
    expect(second.nodes).toHaveLength(1);
    expect(second.nodes[0].node.summary).toBe("Task B");
  });

  it("explicit scope overrides auto-scope", () => {
    const { root } = openProject("autoscope-override", "Test", AGENT) as any;
    const plan = handlePlan({
      nodes: [
        { ref: "phase1", parent_ref: root.id, summary: "Phase 1" },
        { ref: "a", parent_ref: "phase1", summary: "Task A" },
        { ref: "phase2", parent_ref: root.id, summary: "Phase 2" },
        { ref: "b", parent_ref: "phase2", summary: "Task B" },
      ],
    }, AGENT);
    const phase2Id = plan.created.find(c => c.ref === "phase2")!.id;

    // Claim Task A (under Phase 1)
    handleNext({ project: "autoscope-override", claim: true }, AGENT);

    // Explicit scope to Phase 2 should override auto-scope
    const result = handleNext({ project: "autoscope-override", scope: phase2Id }, AGENT);
    expect(result.auto_scoped).toBeUndefined();
    expect(result.nodes[0].node.summary).toBe("Task B");
  });

  it("no auto-scope when agent has no active claims", () => {
    const { root } = openProject("autoscope-none", "Test", AGENT) as any;
    handlePlan({
      nodes: [
        { ref: "phase1", parent_ref: root.id, summary: "Phase 1" },
        { ref: "a", parent_ref: "phase1", summary: "Task A" },
        { ref: "phase2", parent_ref: root.id, summary: "Phase 2" },
        { ref: "b", parent_ref: "phase2", summary: "Task B" },
      ],
    }, AGENT);

    // No claims — should return all actionable (no auto-scope)
    const result = handleNext({ project: "autoscope-none" }, AGENT);
    expect(result.auto_scoped).toBeUndefined();
    expect(result.nodes.length).toBeGreaterThanOrEqual(1);
  });
});

describe("progress summaries (#7)", () => {
  it("graph_context shows progress on parent nodes", () => {
    const { root } = openProject("prog-ctx", "Test", AGENT) as any;
    const plan = handlePlan({
      nodes: [
        { ref: "phase", parent_ref: root.id, summary: "Phase 1" },
        { ref: "a", parent_ref: "phase", summary: "Task A" },
        { ref: "b", parent_ref: "phase", summary: "Task B" },
      ],
    }, AGENT);

    const phaseId = plan.created.find((c) => c.ref === "phase")!.id;
    const taskAId = plan.created.find((c) => c.ref === "a")!.id;

    // Before resolving anything: 0/3 (phase + 2 tasks)
    let ctx = handleContext({ node_id: phaseId });
    expect(ctx.children.progress).toEqual({ resolved: 0, total: 3 });

    // Resolve one task
    handleUpdate({ updates: [{ node_id: taskAId, resolved: true, resolved_reason: "done" }] }, AGENT);

    ctx = handleContext({ node_id: phaseId });
    expect(ctx.children.progress).toEqual({ resolved: 1, total: 3 });
  });

  it("graph_context omits progress on leaf nodes", () => {
    const { root } = openProject("prog-leaf", "Test", AGENT) as any;
    handlePlan({
      nodes: [{ ref: "a", parent_ref: root.id, summary: "Leaf task" }],
    }, AGENT);

    const ctx = handleContext({ node_id: root.id });
    const leaf = ctx.children.children![0];
    expect(leaf.progress).toBeUndefined();
  });

  it("graph_tree shows progress on parent nodes", () => {
    const { root } = openProject("prog-tree", "Test", AGENT) as any;
    const plan = handlePlan({
      nodes: [
        { ref: "phase", parent_ref: root.id, summary: "Phase 1" },
        { ref: "a", parent_ref: "phase", summary: "Task A" },
        { ref: "b", parent_ref: "phase", summary: "Task B" },
      ],
    }, AGENT);

    const taskAId = plan.created.find((c) => c.ref === "a")!.id;
    handleUpdate({ updates: [{ node_id: taskAId, resolved: true, resolved_reason: "done" }] }, AGENT);

    const result = handleTree({ project: "prog-tree" });
    // Root has progress over all 4 nodes (root + phase + 2 tasks)
    expect(result.tree.progress).toEqual({ resolved: 1, total: 4 });
    // Phase has progress over its subtree (phase + 2 tasks)
    const phase = result.tree.children!.find((c) => c.summary === "Phase 1");
    expect(phase!.progress).toEqual({ resolved: 1, total: 3 });
  });

  it("graph_tree leaf nodes have no progress", () => {
    const { root } = openProject("prog-tree-leaf", "Test", AGENT) as any;
    handlePlan({
      nodes: [{ ref: "a", parent_ref: root.id, summary: "Leaf" }],
    }, AGENT);

    const result = handleTree({ project: "prog-tree-leaf" });
    const leaf = result.tree.children![0];
    expect(leaf.progress).toBeUndefined();
  });
});

describe("blocked polish", () => {
  it("requires blocked_reason when setting blocked: true", () => {
    const { root } = openProject("blk-reason", "Test", AGENT) as any;
    const plan = handlePlan({ nodes: [{ ref: "a", parent_ref: root.id, summary: "Task" }] }, AGENT);
    const id = plan.created[0].id;

    expect(() => {
      handleUpdate({ updates: [{ node_id: id, blocked: true }] }, AGENT);
    }).toThrow(/blocked_reason/);
  });

  it("allows blocked: true when blocked_reason is provided", () => {
    const { root } = openProject("blk-reason-ok", "Test", AGENT) as any;
    const plan = handlePlan({ nodes: [{ ref: "a", parent_ref: root.id, summary: "Task" }] }, AGENT);
    const id = plan.created[0].id;

    handleUpdate({ updates: [{ node_id: id, blocked: true, blocked_reason: "Waiting on API" }] }, AGENT);
    const ctx = handleContext({ node_id: id });
    expect(ctx.node.blocked).toBe(true);
    expect(ctx.node.blocked_reason).toBe("Waiting on API");
  });

  it("onboard tree includes blocked and blocked_reason", () => {
    const { root } = openProject("blk-onboard", "Test", AGENT) as any;
    const plan = handlePlan({
      nodes: [
        { ref: "a", parent_ref: root.id, summary: "Blocked task" },
        { ref: "b", parent_ref: root.id, summary: "Free task" },
      ],
    }, AGENT);
    const idA = plan.created.find((c) => c.ref === "a")!.id;

    handleUpdate({ updates: [{ node_id: idA, blocked: true, blocked_reason: "Needs review" }] }, AGENT);

    const onboard = handleOnboard({ project: "blk-onboard" }) as any;
    const blockedNode = onboard.tree.find((n: any) => n.summary === "Blocked task");
    const freeNode = onboard.tree.find((n: any) => n.summary === "Free task");

    expect(blockedNode.blocked).toBe(true);
    expect(blockedNode.blocked_reason).toBe("Needs review");
    expect(freeNode.blocked).toBe(false);
    expect(freeNode.blocked_reason).toBeNull();
  });

  it("blocked + dependency interaction: manually blocked takes precedence", () => {
    const { root } = openProject("blk-dep", "Test", AGENT) as any;
    const plan = handlePlan({
      nodes: [
        { ref: "dep", parent_ref: root.id, summary: "Dependency" },
        { ref: "task", parent_ref: root.id, summary: "Task", depends_on: ["dep"] },
      ],
    }, AGENT);
    const taskId = plan.created.find((c) => c.ref === "task")!.id;
    const depId = plan.created.find((c) => c.ref === "dep")!.id;

    // Manually block the task (it's also dep-blocked)
    handleUpdate({ updates: [{ node_id: taskId, blocked: true, blocked_reason: "External blocker" }] }, AGENT);

    // Resolve the dependency
    handleUpdate({ updates: [{ node_id: depId, resolved: true, add_evidence: [{ type: "note", ref: "Done" }] }] }, AGENT);

    // Task is still manually blocked — should not appear in graph_next
    const next = handleNext({ project: "blk-dep" }, AGENT);
    expect(next.nodes).toHaveLength(0);

    // Unblock manually
    handleUpdate({ updates: [{ node_id: taskId, blocked: false }] }, AGENT);
    const next2 = handleNext({ project: "blk-dep" }, AGENT);
    expect(next2.nodes).toHaveLength(1);
    expect(next2.nodes[0].node.id).toBe(taskId);
  });
});

describe("graph_status", () => {
  it("returns formatted markdown with progress bar and tree", () => {
    const { root } = openProject("stat", "Build a widget", AGENT) as any;
    const plan = handlePlan({
      nodes: [
        { ref: "a", parent_ref: root.id, summary: "Design the widget" },
        { ref: "b", parent_ref: root.id, summary: "Implement the widget", depends_on: ["a"] },
      ],
    }, AGENT);
    const idA = plan.created.find((c) => c.ref === "a")!.id;

    handleUpdate({ updates: [{ node_id: idA, resolved: true, add_evidence: [{ type: "note", ref: "Done" }] }] }, AGENT);

    const result = handleStatus({ project: "stat" }) as any;
    expect(result.formatted).toContain("# stat");
    expect(result.formatted).toContain("[x] Design the widget");
    expect(result.formatted).toContain("[ ] Implement the widget");
    expect(result.formatted).toContain("1/2 (50%)");
    expect(result.formatted).toContain("## Recent Activity");
  });

  it("shows blocked items with reasons", () => {
    const { root } = openProject("stat-blk", "Test", AGENT) as any;
    const plan = handlePlan({
      nodes: [{ ref: "a", parent_ref: root.id, summary: "Blocked task" }],
    }, AGENT);
    const id = plan.created[0].id;

    handleUpdate({ updates: [{ node_id: id, blocked: true, blocked_reason: "Needs API key" }] }, AGENT);

    const result = handleStatus({ project: "stat-blk" }) as any;
    expect(result.formatted).toContain("[!] Blocked task");
    expect(result.formatted).toContain("Needs API key");
    expect(result.formatted).toContain("## Blocked");
  });

  it("shows dependency-blocked as waiting", () => {
    const { root } = openProject("stat-dep", "Test", AGENT) as any;
    handlePlan({
      nodes: [
        { ref: "a", parent_ref: root.id, summary: "First" },
        { ref: "b", parent_ref: root.id, summary: "Second", depends_on: ["a"] },
      ],
    }, AGENT);

    const result = handleStatus({ project: "stat-dep" }) as any;
    expect(result.formatted).toContain("[ ] First");
    expect(result.formatted).toContain("[~] Second");
  });

  it("shows inline progress on parent nodes", () => {
    const { root } = openProject("stat-tree", "Test", AGENT) as any;
    const plan = handlePlan({
      nodes: [
        { ref: "phase", parent_ref: root.id, summary: "Phase 1" },
        { ref: "t1", parent_ref: "phase", summary: "Task 1" },
        { ref: "t2", parent_ref: "phase", summary: "Task 2" },
      ],
    }, AGENT);
    const t1Id = plan.created.find((c) => c.ref === "t1")!.id;

    handleUpdate({ updates: [{ node_id: t1Id, resolved: true, add_evidence: [{ type: "note", ref: "Done" }] }] }, AGENT);

    const result = handleStatus({ project: "stat-tree" }) as any;
    // Parent should show inline progress
    expect(result.formatted).toContain("[ ] Phase 1 (1/2");
    // Children should be indented
    expect(result.formatted).toContain("  [x] Task 1");
    expect(result.formatted).toContain("  [ ] Task 2");
  });

  it("shows recent activity", () => {
    const { root } = openProject("stat-act", "Test", AGENT) as any;
    const plan = handlePlan({
      nodes: [{ ref: "a", parent_ref: root.id, summary: "Do something" }],
    }, AGENT);
    const id = plan.created[0].id;
    handleUpdate({ updates: [{ node_id: id, resolved: true, add_evidence: [{ type: "note", ref: "Done" }] }] }, AGENT);

    const result = handleStatus({ project: "stat-act" }) as any;
    expect(result.formatted).toContain("## Recent Activity");
    expect(result.formatted).toContain("Do something");
    expect(result.formatted).toContain(AGENT);
  });

  it("includes knowledge entries", () => {
    const { root } = openProject("stat-know", "Test", AGENT) as any;
    handlePlan({ nodes: [{ ref: "a", parent_ref: root.id, summary: "Task" }] }, AGENT);
    handleKnowledgeWrite({ project: "stat-know", key: "architecture", content: "Some notes" }, AGENT);

    const result = handleStatus({ project: "stat-know" }) as any;
    expect(result.formatted).toContain("## Knowledge");
    expect(result.formatted).toContain("architecture");
  });

  it("auto-selects single project", () => {
    openProject("stat-auto", "Test", AGENT);
    const result = handleStatus({}) as any;
    expect(result.project).toBe("stat-auto");
    expect(result.formatted).toContain("# stat-auto");
  });

  it("returns multi-project overview when multiple exist", () => {
    openProject("stat-m1", "First project", AGENT);
    openProject("stat-m2", "Second project", AGENT);
    const result = handleStatus({}) as any;
    expect(result.projects).toHaveLength(2);
    expect(result.hint).toContain("stat-m1");
    expect(result.hint).toContain("stat-m2");
  });
});

describe("continuity_confidence", () => {
  it("returns high confidence for well-maintained project", () => {
    const { root } = openProject("cc-high", "Test", AGENT) as any;
    const plan = handlePlan({
      nodes: [
        { ref: "a", parent_ref: root.id, summary: "Task A" },
        { ref: "b", parent_ref: root.id, summary: "Task B" },
      ],
    }, AGENT);

    // Resolve both with evidence
    handleUpdate({ updates: [{ node_id: plan.created[0].id, resolved: true, add_evidence: [{ type: "note", ref: "Done A" }] }] }, AGENT);
    handleUpdate({ updates: [{ node_id: plan.created[1].id, resolved: true, add_evidence: [{ type: "note", ref: "Done B" }] }] }, AGENT);

    const cc = computeContinuityConfidence("cc-high");
    expect(cc.confidence).toBe("high");
    expect(cc.score).toBeGreaterThanOrEqual(70);
    expect(cc.reasons).toHaveLength(0);
  });

  it("returns lower confidence when tasks resolved without evidence", () => {
    const { root } = openProject("cc-low", "Test", AGENT) as any;
    const plan = handlePlan({
      nodes: [
        { ref: "a", parent_ref: root.id, summary: "Task A" },
        { ref: "b", parent_ref: root.id, summary: "Task B" },
      ],
    }, AGENT);

    // Resolve one with evidence
    handleUpdate({ updates: [{ node_id: plan.created[0].id, resolved: true, add_evidence: [{ type: "note", ref: "Done" }] }] }, AGENT);

    // Force-resolve one without evidence (raw SQL to bypass all validation)
    getDb().prepare("UPDATE nodes SET resolved = 1 WHERE id = ?").run(plan.created[1].id);

    const cc = computeContinuityConfidence("cc-low");
    // 1 of 2 has evidence — 50% coverage should deduct points
    expect(cc.score).toBeLessThan(100);
    expect(cc.reasons.some(r => r.includes("no evidence"))).toBe(true);
  });

  it("flags missing knowledge on mature projects", () => {
    const { root } = openProject("cc-know", "Test", AGENT) as any;
    const plan = handlePlan({
      nodes: [
        { ref: "a", parent_ref: root.id, summary: "Task 1" },
        { ref: "b", parent_ref: root.id, summary: "Task 2" },
        { ref: "c", parent_ref: root.id, summary: "Task 3" },
        { ref: "d", parent_ref: root.id, summary: "Task 4" },
        { ref: "e", parent_ref: root.id, summary: "Task 5" },
      ],
    }, AGENT);

    // Resolve all with evidence
    for (const c of plan.created) {
      handleUpdate({ updates: [{ node_id: c.id, resolved: true, add_evidence: [{ type: "note", ref: "Done" }] }] }, AGENT);
    }

    const cc = computeContinuityConfidence("cc-know");
    expect(cc.reasons.some(r => r.includes("knowledge"))).toBe(true);
  });

  it("shows in graph_onboard response", () => {
    const { root } = openProject("cc-onboard", "Test", AGENT) as any;
    handlePlan({ nodes: [{ ref: "a", parent_ref: root.id, summary: "Task" }] }, AGENT);

    const result = handleOnboard({ project: "cc-onboard" }) as any;
    expect(result.continuity_confidence).toBeDefined();
    expect(result.continuity_confidence.confidence).toBeDefined();
    expect(result.continuity_confidence.score).toBeGreaterThanOrEqual(0);
    expect(result.continuity_confidence.reasons).toBeDefined();
  });

  it("shows in graph_status formatted output", () => {
    const { root } = openProject("cc-status", "Test", AGENT) as any;
    handlePlan({ nodes: [{ ref: "a", parent_ref: root.id, summary: "Task" }] }, AGENT);

    const result = handleStatus({ project: "cc-status" }) as any;
    expect(result.formatted).toContain("continuity confidence:");
  });

  it("returns high for empty project (no resolved tasks to judge)", () => {
    const { root } = openProject("cc-empty", "Test", AGENT) as any;
    handlePlan({ nodes: [{ ref: "a", parent_ref: root.id, summary: "Task" }] }, AGENT);

    const cc = computeContinuityConfidence("cc-empty");
    // No resolved tasks means no evidence penalty, only the "no tasks" penalty doesn't apply since we have one
    expect(cc.confidence).toBe("high");
  });
});

describe("delete protection", () => {
  it("prevents deleting a project with evidence", () => {
    const { root } = openProject("del-protect", "Test", AGENT) as any;
    const plan = handlePlan({ nodes: [{ ref: "a", parent_ref: root.id, summary: "Task" }] }, AGENT);
    const id = plan.created[0].id;

    // Resolve with evidence
    handleUpdate({ updates: [{ node_id: id, resolved: true, add_evidence: [{ type: "note", ref: "Done" }] }] }, AGENT);

    // Attempt to delete the project root
    expect(() => {
      handleRestructure({ operations: [{ op: "delete", node_id: root.id }] }, AGENT);
    }).toThrow(/Cannot delete project/);
  });

  it("allows deleting a project with no evidence", () => {
    const { root } = openProject("del-empty", "Test", AGENT) as any;
    handlePlan({ nodes: [{ ref: "a", parent_ref: root.id, summary: "Task" }] }, AGENT);

    // No evidence added — delete should succeed
    const result = handleRestructure({ operations: [{ op: "delete", node_id: root.id }] }, AGENT);
    expect(result.applied).toBe(1);
  });
});

describe("graph_retro", () => {
  it("returns context without findings (first call)", () => {
    const { root } = openProject("retro-test", "Test retro", AGENT) as any;

    // Create and resolve a task
    const plan = handlePlan({ nodes: [{ ref: "a", parent_ref: root.id, summary: "Task A" }] }, AGENT);
    handleUpdate({
      updates: [{ node_id: plan.created[0].id, resolved: true, add_evidence: [{ type: "note", ref: "Did the thing" }] }],
    }, AGENT);

    const result = handleRetro({ project: "retro-test" }, AGENT) as any;
    expect(result.context.task_count).toBe(1);
    expect(result.context.resolved_since_last_retro).toHaveLength(1);
    expect(result.context.resolved_since_last_retro[0].summary).toBe("Task A");
    expect(result.stored).toBeUndefined();
    expect(result.hint).toContain("1 task(s) resolved");
  });

  it("stores findings as knowledge entry", () => {
    const { root } = openProject("retro-store", "Test retro", AGENT) as any;

    // Create and resolve a task
    const plan = handlePlan({ nodes: [{ ref: "a", parent_ref: root.id, summary: "Task A" }] }, AGENT);
    handleUpdate({
      updates: [{ node_id: plan.created[0].id, resolved: true, add_evidence: [{ type: "note", ref: "Done" }] }],
    }, AGENT);

    const result = handleRetro({
      project: "retro-store",
      findings: [
        { category: "workflow_improvement", insight: "Build step was slow" },
        { category: "claude_md_candidate", insight: "Always check graph knowledge first", suggestion: "Check graph_knowledge_read before searching files" },
      ],
    }, AGENT) as any;

    expect(result.stored.finding_count).toBe(2);
    expect(result.stored.claude_md_candidates).toHaveLength(1);
    expect(result.stored.claude_md_candidates[0].suggestion).toContain("graph_knowledge_read");
    expect(result.hint).toContain("CLAUDE.md candidate");

    // Verify knowledge entry was created
    const knowledge = handleKnowledgeRead({ project: "retro-store" }) as any;
    const retroEntry = knowledge.entries.find((e: any) => e.key.startsWith("retro-"));
    expect(retroEntry).toBeDefined();
    expect(retroEntry.content).toContain("CLAUDE.md Instruction Candidates");
    expect(retroEntry.content).toContain("Always check graph knowledge first");
  });

  it("scopes retro to a subtree", () => {
    const { root } = openProject("retro-scope", "Test retro", AGENT) as any;

    // Create two branches
    const plan = handlePlan({
      nodes: [
        { ref: "parent-a", parent_ref: root.id, summary: "Branch A" },
        { ref: "a1", parent_ref: "parent-a", summary: "A1" },
        { ref: "parent-b", parent_ref: root.id, summary: "Branch B" },
        { ref: "b1", parent_ref: "parent-b", summary: "B1" },
      ],
    }, AGENT);

    // Resolve tasks in both branches
    handleUpdate({
      updates: [{ node_id: plan.created[1].id, resolved: true, add_evidence: [{ type: "note", ref: "Done A1" }] }],
    }, AGENT);
    handleUpdate({
      updates: [{ node_id: plan.created[3].id, resolved: true, add_evidence: [{ type: "note", ref: "Done B1" }] }],
    }, AGENT);

    // Retro scoped to Branch A
    const result = handleRetro({ project: "retro-scope", scope: plan.created[0].id }, AGENT) as any;
    expect(result.context.task_count).toBe(1);
    expect(result.context.resolved_since_last_retro[0].summary).toBe("A1");
  });

  it("second retro only shows tasks resolved since first retro", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T10:00:00.000Z"));
      const { root } = openProject("retro-since", "Test retro", AGENT) as any;

      // Create and resolve first task
      const plan1 = handlePlan({ nodes: [{ ref: "a", parent_ref: root.id, summary: "Task A" }] }, AGENT);
      handleUpdate({
        updates: [{ node_id: plan1.created[0].id, resolved: true, add_evidence: [{ type: "note", ref: "Done A" }] }],
      }, AGENT);

      // Advance time, then file first retro
      vi.setSystemTime(new Date("2026-01-01T10:01:00.000Z"));
      handleRetro({
        project: "retro-since",
        findings: [{ category: "workflow_improvement", insight: "First retro finding" }],
      }, AGENT);

      // Advance time, then create and resolve second task
      vi.setSystemTime(new Date("2026-01-01T10:02:00.000Z"));
      const plan2 = handlePlan({ nodes: [{ ref: "b", parent_ref: root.id, summary: "Task B" }] }, AGENT);
      handleUpdate({
        updates: [{ node_id: plan2.created[0].id, resolved: true, add_evidence: [{ type: "note", ref: "Done B" }] }],
      }, AGENT);

      // Second retro should only show Task B
      const result = handleRetro({ project: "retro-since" }, AGENT) as any;
      expect(result.context.task_count).toBe(1);
      expect(result.context.resolved_since_last_retro[0].summary).toBe("Task B");
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects invalid finding categories", () => {
    openProject("retro-invalid", "Test retro", AGENT);

    expect(() =>
      handleRetro({
        project: "retro-invalid",
        findings: [{ category: "invalid_category" as any, insight: "Something" }],
      }, AGENT)
    ).toThrow(/category must be one of/);
  });

  it("returns empty context when no tasks resolved", () => {
    openProject("retro-empty", "Test retro", AGENT);

    const result = handleRetro({ project: "retro-empty" }, AGENT) as any;
    expect(result.context.task_count).toBe(0);
    expect(result.hint).toContain("Nothing to reflect on");
  });

  it("throws on non-existent project", () => {
    expect(() =>
      handleRetro({ project: "nonexistent" }, AGENT)
    ).toThrow(/Project not found/);
  });
});

describe("retro nudges", () => {
  it("graph_update nudges retro when parent auto-resolves", () => {
    const { root } = openProject("nudge-update", "Test nudge", AGENT) as any;
    const plan = handlePlan({
      nodes: [
        { ref: "parent", parent_ref: root.id, summary: "Feature A" },
        { ref: "child", parent_ref: "parent", summary: "Task 1" },
        { ref: "other", parent_ref: root.id, summary: "Other work" },
      ],
    }, AGENT);

    // Resolve the only child of "Feature A" — auto-resolves parent, but root still has "Other work"
    const result = handleUpdate({
      updates: [{ node_id: plan.created[1].id, resolved: true, add_evidence: [{ type: "note", ref: "Done" }] }],
    }, AGENT) as any;

    expect(result.auto_resolved).toHaveLength(1);
    expect(result.retro_nudge).toBeDefined();
    expect(result.retro_nudge).toContain("Milestone completed");
    expect(result.retro_nudge).toContain("Feature A");
    expect(result.retro_nudge).toContain("graph_retro");
  });

  it("graph_update has no retro nudge when no auto-resolve", () => {
    const { root } = openProject("nudge-none", "Test nudge", AGENT) as any;
    const plan = handlePlan({
      nodes: [
        { ref: "a", parent_ref: root.id, summary: "Task A" },
        { ref: "b", parent_ref: root.id, summary: "Task B" },
      ],
    }, AGENT);

    // Resolve one task — parent still has unresolved children
    const result = handleUpdate({
      updates: [{ node_id: plan.created[0].id, resolved: true, add_evidence: [{ type: "note", ref: "Done" }] }],
    }, AGENT) as any;

    expect(result.retro_nudge).toBeUndefined();
  });

  it("graph_next nudges retro after threshold resolved tasks", () => {
    const { root } = openProject("nudge-next", "Test nudge", AGENT) as any;

    // Create 6 tasks (threshold is 5)
    const refs = Array.from({ length: 6 }, (_, i) => ({
      ref: `t${i}`, parent_ref: root.id, summary: `Task ${i}`,
    }));
    const plan = handlePlan({ nodes: refs }, AGENT);

    // Resolve 5 of them
    for (let i = 0; i < 5; i++) {
      handleUpdate({
        updates: [{ node_id: plan.created[i].id, resolved: true, add_evidence: [{ type: "note", ref: "Done" }] }],
      }, AGENT);
    }

    // graph_next should include retro nudge
    const next = handleNext({ project: "nudge-next" }, AGENT) as any;
    expect(next.retro_nudge).toBeDefined();
    expect(next.retro_nudge).toContain("5 task(s) resolved since last retro");
    expect(next.retro_nudge).toContain("graph_retro");
  });

  it("graph_next has no nudge below threshold", () => {
    const { root } = openProject("nudge-below", "Test nudge", AGENT) as any;

    // Create and resolve 3 tasks (below threshold of 5)
    const plan = handlePlan({
      nodes: [
        { ref: "a", parent_ref: root.id, summary: "Task A" },
        { ref: "b", parent_ref: root.id, summary: "Task B" },
        { ref: "c", parent_ref: root.id, summary: "Task C" },
        { ref: "d", parent_ref: root.id, summary: "Task D" },
      ],
    }, AGENT);

    for (let i = 0; i < 3; i++) {
      handleUpdate({
        updates: [{ node_id: plan.created[i].id, resolved: true, add_evidence: [{ type: "note", ref: "Done" }] }],
      }, AGENT);
    }

    const next = handleNext({ project: "nudge-below" }, AGENT) as any;
    expect(next.retro_nudge).toBeUndefined();
  });

  it("graph_next nudge resets after retro is filed", () => {
    const { root } = openProject("nudge-reset", "Test nudge", AGENT) as any;

    // Create and resolve 6 tasks
    const refs = Array.from({ length: 6 }, (_, i) => ({
      ref: `t${i}`, parent_ref: root.id, summary: `Task ${i}`,
    }));
    const plan = handlePlan({ nodes: refs }, AGENT);

    for (let i = 0; i < 5; i++) {
      handleUpdate({
        updates: [{ node_id: plan.created[i].id, resolved: true, add_evidence: [{ type: "note", ref: "Done" }] }],
      }, AGENT);
    }

    // Nudge should be present
    let next = handleNext({ project: "nudge-reset" }, AGENT) as any;
    expect(next.retro_nudge).toBeDefined();

    // File a retro
    handleRetro({
      project: "nudge-reset",
      findings: [{ category: "workflow_improvement", insight: "Things went well" }],
    }, AGENT);

    // Nudge should be gone (only 0 tasks resolved since retro)
    next = handleNext({ project: "nudge-reset" }, AGENT) as any;
    expect(next.retro_nudge).toBeUndefined();
  });
});

describe("graph_resolve", () => {
  it("resolves a node with message as note evidence", () => {
    const { root } = openProject("resolve-basic", "Test resolve", AGENT) as any;
    const plan = handlePlan({
      nodes: [{ ref: "a", parent_ref: root.id, summary: "Task A" }],
    }, AGENT);

    const result = handleResolve({
      node_id: plan.created[0].id,
      message: "Implemented the feature",
    }, AGENT) as any;

    expect(result.node_id).toBe(plan.created[0].id);
    expect(result.evidence_collected.has_note).toBe(true);
    // git_commits depends on environment (>= 0 in CI, > 0 in local git repo)
    expect(result.evidence_collected.git_commits).toBeGreaterThanOrEqual(0);
  });

  it("includes test_result as test evidence", () => {
    const { root } = openProject("resolve-test", "Test resolve", AGENT) as any;
    const plan = handlePlan({
      nodes: [{ ref: "a", parent_ref: root.id, summary: "Task A" }],
    }, AGENT);

    const result = handleResolve({
      node_id: plan.created[0].id,
      message: "Built the thing",
      test_result: "42 tests passing",
    }, AGENT) as any;

    expect(result.evidence_collected.has_test).toBe(true);
    expect(result.evidence_collected.has_note).toBe(true);
  });

  it("uses explicit commit instead of auto-detection", () => {
    const { root } = openProject("resolve-commit", "Test resolve", AGENT) as any;
    const plan = handlePlan({
      nodes: [{ ref: "a", parent_ref: root.id, summary: "Task A" }],
    }, AGENT);

    const result = handleResolve({
      node_id: plan.created[0].id,
      message: "Fixed the bug",
      commit: "abc123 — Fix null pointer in handler",
    }, AGENT) as any;

    expect(result.evidence_collected.git_commits).toBe(1);
  });

  it("uses explicit context_links", () => {
    const { root } = openProject("resolve-links", "Test resolve", AGENT) as any;
    const plan = handlePlan({
      nodes: [{ ref: "a", parent_ref: root.id, summary: "Task A" }],
    }, AGENT);

    const result = handleResolve({
      node_id: plan.created[0].id,
      message: "Updated the files",
      context_links: ["src/foo.ts", "src/bar.ts"],
    }, AGENT) as any;

    expect(result.evidence_collected.context_links).toBe(2);
  });

  it("triggers auto-resolve on parent when siblings are done", () => {
    const { root } = openProject("resolve-auto", "Test resolve", AGENT) as any;
    const plan = handlePlan({
      nodes: [
        { ref: "parent", parent_ref: root.id, summary: "Parent" },
        { ref: "a", parent_ref: "parent", summary: "Child A" },
        { ref: "b", parent_ref: "parent", summary: "Child B" },
      ],
    }, AGENT);

    // Resolve first child via graph_update
    handleUpdate({
      updates: [{ node_id: plan.created[1].id, resolved: true, add_evidence: [{ type: "note", ref: "Done A" }] }],
    }, AGENT);

    // Resolve second child via graph_resolve — should auto-resolve parent
    const result = handleResolve({
      node_id: plan.created[2].id,
      message: "Done B",
    }, AGENT) as any;

    expect(result.auto_resolved).toBeDefined();
    expect(result.auto_resolved.length).toBeGreaterThanOrEqual(1);
    expect(result.auto_resolved[0].summary).toBe("Parent");
  });

  it("returns newly_actionable when dependencies are unblocked", () => {
    const { root } = openProject("resolve-unblock", "Test resolve", AGENT) as any;
    const plan = handlePlan({
      nodes: [
        { ref: "a", parent_ref: root.id, summary: "Blocker" },
        { ref: "b", parent_ref: root.id, summary: "Blocked task", depends_on: ["a"] },
      ],
    }, AGENT);

    const result = handleResolve({
      node_id: plan.created[0].id,
      message: "Blocker done",
    }, AGENT) as any;

    expect(result.newly_actionable).toBeDefined();
    expect(result.newly_actionable.some((n: any) => n.summary === "Blocked task")).toBe(true);
  });

  it("throws without required fields", () => {
    expect(() => handleResolve({ node_id: "", message: "test" } as any, AGENT)).toThrow();
    expect(() => handleResolve({ node_id: "abc" } as any, AGENT)).toThrow();
  });
});

describe("integrity audit", () => {
  it("returns clean score for well-maintained project", () => {
    const { root } = openProject("integrity-clean", "Clean project", AGENT) as any;
    const plan = handlePlan({
      nodes: [{ ref: "a", parent_ref: root.id, summary: "Task A" }],
    }, AGENT);

    // Resolve with good evidence + context_links
    handleUpdate({
      updates: [{
        node_id: plan.created[0].id,
        resolved: true,
        add_evidence: [
          { type: "git", ref: "abc123 — fix thing" },
          { type: "note", ref: "Did the thing" },
        ],
        add_context_links: ["src/foo.ts"],
      }],
    }, AGENT);

    const result = computeIntegrity("integrity-clean");
    expect(result.score).toBe(100);
    expect(result.issues).toHaveLength(0);
  });

  it("flags weak evidence — resolved without git or context_links", () => {
    const { root } = openProject("integrity-weak", "Weak project", AGENT) as any;
    const plan = handlePlan({
      nodes: [{ ref: "a", parent_ref: root.id, summary: "Task A" }],
    }, AGENT);

    // Resolve with only a note (no git, no context_links)
    handleUpdate({
      updates: [{
        node_id: plan.created[0].id,
        resolved: true,
        add_evidence: [{ type: "note", ref: "Did it" }],
      }],
    }, AGENT);

    const result = computeIntegrity("integrity-weak");
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.issues[0].type).toBe("weak_evidence");
    expect(result.score).toBeLessThan(100);
  });

  it("flags stale claims — claimed > 24h ago", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T10:00:00.000Z"));
      const { root } = openProject("integrity-stale-claim", "Stale claim", AGENT) as any;
      const plan = handlePlan({
        nodes: [{ ref: "a", parent_ref: root.id, summary: "Task A" }],
      }, AGENT);

      // Claim the task
      handleUpdate({
        updates: [{
          node_id: plan.created[0].id,
          properties: { _claimed_by: "some-agent", _claimed_at: "2026-01-01T10:00:00.000Z" },
        }],
      }, AGENT);

      // Advance 25 hours
      vi.setSystemTime(new Date("2026-01-02T11:00:00.000Z"));

      const result = computeIntegrity("integrity-stale-claim");
      const staleClaims = result.issues.filter(i => i.type === "stale_claim");
      expect(staleClaims.length).toBe(1);
      expect(staleClaims[0].detail).toContain("some-agent");
    } finally {
      vi.useRealTimers();
    }
  });

  it("flags orphan nodes — unresolved child of resolved parent", () => {
    const { root } = openProject("integrity-orphan", "Orphan test", AGENT) as any;
    const plan = handlePlan({
      nodes: [
        { ref: "parent", parent_ref: root.id, summary: "Parent task" },
        { ref: "child", parent_ref: "parent", summary: "Child task" },
      ],
    }, AGENT);

    // Force-resolve parent without resolving child (bypass auto-resolve by directly updating DB)
    const db = getDb();
    db.prepare("UPDATE nodes SET resolved = 1, evidence = ? WHERE id = ?").run(
      JSON.stringify([{ type: "note", ref: "manual", agent: AGENT, timestamp: new Date().toISOString() }]),
      plan.created[0].id
    );

    const result = computeIntegrity("integrity-orphan");
    const orphans = result.issues.filter(i => i.type === "orphan");
    expect(orphans.length).toBe(1);
    expect(orphans[0].summary).toBe("Child task");
  });

  it("flags stale tasks — unresolved, unclaimed, old", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T10:00:00.000Z"));
      const { root } = openProject("integrity-stale-task", "Stale tasks", AGENT) as any;
      handlePlan({
        nodes: [{ ref: "a", parent_ref: root.id, summary: "Old task" }],
      }, AGENT);

      // Advance 8 days
      vi.setSystemTime(new Date("2026-01-09T10:00:00.000Z"));

      const result = computeIntegrity("integrity-stale-task");
      const stale = result.issues.filter(i => i.type === "stale_task");
      expect(stale.length).toBeGreaterThan(0);
      expect(stale[0].detail).toContain("days");
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips auto-resolved nodes for weak evidence check", () => {
    const { root } = openProject("integrity-auto", "Auto-resolve", AGENT) as any;
    const plan = handlePlan({
      nodes: [
        { ref: "parent", parent_ref: root.id, summary: "Parent" },
        { ref: "child", parent_ref: "parent", summary: "Child" },
      ],
    }, AGENT);

    // Resolve child with good evidence — parent auto-resolves
    handleUpdate({
      updates: [{
        node_id: plan.created[1].id,
        resolved: true,
        add_evidence: [
          { type: "git", ref: "abc — done" },
          { type: "note", ref: "Implemented" },
        ],
        add_context_links: ["src/file.ts"],
      }],
    }, AGENT);

    const result = computeIntegrity("integrity-auto");
    // Parent auto-resolved — should NOT be flagged as weak evidence
    const weakParent = result.issues.filter(i => i.type === "weak_evidence" && i.summary === "Parent");
    expect(weakParent).toHaveLength(0);
  });

  it("surfaces in graph_onboard response", () => {
    const { root } = openProject("integrity-onboard", "Onboard test", AGENT) as any;
    const plan = handlePlan({
      nodes: [{ ref: "a", parent_ref: root.id, summary: "Task" }],
    }, AGENT);
    handleUpdate({
      updates: [{
        node_id: plan.created[0].id,
        resolved: true,
        add_evidence: [{ type: "note", ref: "Done" }],
      }],
    }, AGENT);

    const onboard = handleOnboard({ project: "integrity-onboard" }) as any;
    expect(onboard.integrity).toBeDefined();
    expect(onboard.integrity.score).toBeDefined();
    expect(onboard.integrity.issues).toBeDefined();
  });

  it("surfaces in graph_status formatted output", () => {
    const { root } = openProject("integrity-status", "Status test", AGENT) as any;
    const plan = handlePlan({
      nodes: [{ ref: "a", parent_ref: root.id, summary: "Task" }],
    }, AGENT);
    // Resolve with weak evidence to trigger integrity section
    handleUpdate({
      updates: [{
        node_id: plan.created[0].id,
        resolved: true,
        add_evidence: [{ type: "note", ref: "Done" }],
      }],
    }, AGENT);

    const status = handleStatus({ project: "integrity-status" }) as any;
    expect(status.formatted).toContain("Integrity");
    expect(status.formatted).toContain("Weak Evidence");
  });
});

// [sl:Klw0ZCFcnBXBqf0Quhqsf] Auto-remediation suggestions
describe("auto-remediation", () => {
  beforeEach(() => initDb(":memory:"));

  it("includes suggestion on integrity issues", () => {
    const { root } = openProject("remediation", "Test remediation", AGENT) as any;
    const plan = handlePlan({ nodes: [
      { ref: "a", parent_ref: root.id, summary: "Task A" },
    ] }, AGENT);
    // Resolve without evidence
    handleUpdate({ updates: [{ node_id: plan.created[0].id, resolved: true, resolved_reason: "done" }] }, AGENT);

    const integrity = computeIntegrity("remediation");
    const weakIssues = integrity.issues.filter(i => i.type === "weak_evidence");
    expect(weakIssues.length).toBeGreaterThan(0);
    for (const issue of weakIssues) {
      expect(issue.suggestion).toBeDefined();
      expect(issue.suggestion.length).toBeGreaterThan(0);
      expect(issue.suggestion).toContain("graph_update");
    }
  });

  it("includes suggestion on stale claims", () => {
    vi.useFakeTimers();
    try {
      const { root } = openProject("stale-sug", "Test stale", AGENT) as any;
      const plan = handlePlan({ nodes: [
        { ref: "a", parent_ref: root.id, summary: "Task A" },
      ] }, AGENT);
      handleUpdate({ updates: [{ node_id: plan.created[0].id, properties: { _claimed_by: "old-agent", _claimed_at: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString() } }] }, AGENT);

      const integrity = computeIntegrity("stale-sug");
      const staleClaims = integrity.issues.filter(i => i.type === "stale_claim");
      expect(staleClaims.length).toBe(1);
      expect(staleClaims[0].suggestion).toContain("_claimed_by");
    } finally {
      vi.useRealTimers();
    }
  });
});

// [sl:Aqr3gbYg_XDgv2YOj8_qb] Quality KPI tracking
describe("quality KPI", () => {
  beforeEach(() => initDb(":memory:"));

  it("returns 100% for empty projects", () => {
    openProject("qkpi-empty", "Test QKI", AGENT);
    const integrity = computeIntegrity("qkpi-empty");
    expect(integrity.quality_kpi.percentage).toBe(100);
    expect(integrity.quality_kpi.resolved).toBe(0);
  });

  it("tracks high-quality evidence percentage", () => {
    const { root } = openProject("qkpi", "Test quality", AGENT) as any;
    const plan = handlePlan({ nodes: [
      { ref: "a", parent_ref: root.id, summary: "Good task" },
      { ref: "b", parent_ref: root.id, summary: "Weak task" },
    ] }, AGENT);

    // High quality: git + note + context_links
    handleUpdate({ updates: [{
      node_id: plan.created[0].id,
      resolved: true,
      add_evidence: [{ type: "git", ref: "abc123" }, { type: "note", ref: "did stuff" }],
      add_context_links: ["src/foo.ts"],
    }] }, AGENT);

    // Low quality: note only
    handleUpdate({ updates: [{
      node_id: plan.created[1].id,
      resolved: true,
      add_evidence: [{ type: "note", ref: "did stuff" }],
    }] }, AGENT);

    const integrity = computeIntegrity("qkpi");
    expect(integrity.quality_kpi.high_quality).toBe(1);
    expect(integrity.quality_kpi.resolved).toBeGreaterThanOrEqual(2);
    expect(integrity.quality_kpi.percentage).toBeLessThan(100);
  });

  it("shows quality KPI in graph_status", () => {
    const { root } = openProject("qkpi-status", "Test quality status", AGENT) as any;
    const plan = handlePlan({ nodes: [
      { ref: "a", parent_ref: root.id, summary: "Task A" },
    ] }, AGENT);
    handleUpdate({ updates: [{
      node_id: plan.created[0].id,
      resolved: true,
      add_evidence: [{ type: "git", ref: "abc" }, { type: "note", ref: "done" }],
      add_context_links: ["file.ts"],
    }] }, AGENT);

    const status = handleStatus({ project: "qkpi-status" }) as any;
    expect(status.formatted).toContain("quality:");
  });

  it("warns in graph_plan when quality is low", () => {
    const { root: warnRoot } = openProject("qkpi-warn", "Test quality warning", AGENT) as any;
    // Create and resolve 6 tasks without quality evidence
    for (let i = 0; i < 6; i++) {
      const p = handlePlan({ nodes: [{ ref: `t${i}`, parent_ref: warnRoot.id, summary: `Task ${i}` }] }, AGENT);
      handleUpdate({ updates: [{ node_id: p.created[0].id, resolved: true, resolved_reason: "done" }] }, AGENT);
    }

    // Now add new work — should include quality warning
    const result = handlePlan({ nodes: [
      { ref: "new", parent_ref: warnRoot.id, summary: "New task" },
    ] }, AGENT);
    expect(result.quality_warning).toBeDefined();
    expect(result.quality_warning).toContain("quality");
  });
});

// [sl:Mox85EgzSfvuXq-JhMFwW] [sl:KCXJHZdDEnQfK9sOfrYhW] [sl:U9NWRB-786Bm52yOAx8Wd] Onboard UX
describe("onboard UX improvements", () => {
  beforeEach(() => initDb(":memory:"));

  it("includes recommended_next for projects with actionable tasks", () => {
    const { root } = openProject("onboard-ux", "Test onboard UX", AGENT) as any;
    handlePlan({ nodes: [
      { ref: "a", parent_ref: root.id, summary: "Do something", properties: { priority: 5 } },
    ] }, AGENT);

    const result = handleOnboard({ project: "onboard-ux" }) as any;
    expect(result.recommended_next).toBeDefined();
    expect(result.recommended_next.id).toBeDefined();
    expect(result.recommended_next.summary).toBe("Do something");
    expect(result.recommended_next.rationale).toContain("priority");
  });

  it("omits recommended_next for empty projects", () => {
    openProject("onboard-empty", "Empty project", AGENT);
    const result = handleOnboard({ project: "onboard-empty" }) as any;
    expect(result.recommended_next).toBeUndefined();
  });

  it("includes blocked_nodes with reasons and age", () => {
    const { root } = openProject("onboard-blocked", "Test blocked", AGENT) as any;
    const plan = handlePlan({ nodes: [
      { ref: "a", parent_ref: root.id, summary: "Blocked task" },
    ] }, AGENT);
    handleUpdate({ updates: [{ node_id: plan.created[0].id, blocked: true, blocked_reason: "Waiting on design" }] }, AGENT);

    const result = handleOnboard({ project: "onboard-blocked" }) as any;
    expect(result.blocked_nodes).toHaveLength(1);
    expect(result.blocked_nodes[0].id).toBe(plan.created[0].id);
    expect(result.blocked_nodes[0].reason).toBe("Waiting on design");
    expect(result.blocked_nodes[0].age_hours).toBeGreaterThanOrEqual(0);
  });

  it("includes claimed_nodes with owner and age", () => {
    const { root } = openProject("onboard-claimed", "Test claimed", AGENT) as any;
    const plan = handlePlan({ nodes: [
      { ref: "a", parent_ref: root.id, summary: "Claimed task" },
    ] }, AGENT);
    handleUpdate({ updates: [{ node_id: plan.created[0].id, properties: {
      _claimed_by: "some-agent", _claimed_at: new Date().toISOString()
    } }] }, AGENT);

    const result = handleOnboard({ project: "onboard-claimed" }) as any;
    expect(result.claimed_nodes).toHaveLength(1);
    expect(result.claimed_nodes[0].claimed_by).toBe("some-agent");
    expect(result.claimed_nodes[0].age_hours).toBeGreaterThanOrEqual(0);
  });

  it("includes action field on checklist items when issues exist", () => {
    const { root } = openProject("onboard-action", "Test actions", AGENT) as any;
    const plan = handlePlan({ nodes: [
      { ref: "a", parent_ref: root.id, summary: "Blocked task" },
    ] }, AGENT);
    handleUpdate({ updates: [{ node_id: plan.created[0].id, blocked: true, blocked_reason: "External dep" }] }, AGENT);

    const result = handleOnboard({ project: "onboard-action" }) as any;
    const blockerCheck = result.checklist.find((c: any) => c.check === "confirm_blockers");
    expect(blockerCheck).toBeDefined();
    expect(blockerCheck.status).toBe("action_required");
    expect(blockerCheck.action).toBeDefined();
    expect(blockerCheck.action).toContain("unblock");
  });
});

// [sl:rIuWFYZUQAhN0ViM9y0Ey] Strict solo mode
describe("strict solo mode", () => {
  beforeEach(() => initDb(":memory:"));

  it("rejects resolve without required evidence when strict is enabled", () => {
    const proj = handleOpen({ project: "strict-proj", goal: "Strict test" }, AGENT) as any;
    // Enable strict mode on project root
    updateNode({ node_id: proj.root.id, agent: AGENT, discovery: "done", properties: { strict: true } });

    const plan = handlePlan({ nodes: [
      { ref: "a", parent_ref: proj.root.id, summary: "Task A" },
    ] }, AGENT);

    // Try resolving with only a note — should fail (missing git/test + context_links)
    expect(() => {
      handleUpdate({ updates: [{
        node_id: plan.created[0].id,
        resolved: true,
        add_evidence: [{ type: "note", ref: "did stuff" }],
      }] }, AGENT);
    }).toThrow(/Strict mode requires/);
  });

  it("allows resolve with full evidence when strict is enabled", () => {
    const proj = handleOpen({ project: "strict-pass", goal: "Strict pass" }, AGENT) as any;
    updateNode({ node_id: proj.root.id, agent: AGENT, discovery: "done", properties: { strict: true } });

    const plan = handlePlan({ nodes: [
      { ref: "a", parent_ref: proj.root.id, summary: "Task A" },
    ] }, AGENT);

    // Resolve with git + note + context_links — should pass
    const result = handleUpdate({ updates: [{
      node_id: plan.created[0].id,
      resolved: true,
      add_evidence: [{ type: "git", ref: "abc123" }, { type: "note", ref: "did stuff" }],
      add_context_links: ["src/foo.ts"],
    }] }, AGENT);

    // updated includes child + auto-resolved parent (single child)
    expect(result.updated.length).toBeGreaterThanOrEqual(1);
    expect(result.updated[0].node_id).toBe(plan.created[0].id);
  });

  it("does not enforce strict mode when not enabled", () => {
    const { root } = openProject("non-strict", "Non-strict", AGENT) as any;
    const plan = handlePlan({ nodes: [
      { ref: "a", parent_ref: root.id, summary: "Task A" },
    ] }, AGENT);

    // Resolve with minimal evidence — should pass without strict mode
    const result = handleUpdate({ updates: [{
      node_id: plan.created[0].id,
      resolved: true,
      resolved_reason: "done",
    }] }, AGENT);
    expect(result.updated.length).toBeGreaterThanOrEqual(1);
  });

  it("allows test evidence as alternative to git in strict mode", () => {
    const proj = handleOpen({ project: "strict-test", goal: "Strict test evidence" }, AGENT) as any;
    updateNode({ node_id: proj.root.id, agent: AGENT, discovery: "done", properties: { strict: true } });

    const plan = handlePlan({ nodes: [
      { ref: "a", parent_ref: proj.root.id, summary: "Task A" },
    ] }, AGENT);

    const result = handleUpdate({ updates: [{
      node_id: plan.created[0].id,
      resolved: true,
      add_evidence: [{ type: "test", ref: "all pass" }, { type: "note", ref: "did stuff" }],
      add_context_links: ["test/foo.test.ts"],
    }] }, AGENT);
    expect(result.updated.length).toBeGreaterThanOrEqual(1);
    expect(result.updated[0].node_id).toBe(plan.created[0].id);
  });
});
