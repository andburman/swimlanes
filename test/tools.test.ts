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
import { handleOnboard } from "../src/tools/onboard.js";
import { handleAgentConfig } from "../src/tools/agent-config.js";
import { handleTree } from "../src/tools/tree.js";
import { handleStatus } from "../src/tools/status.js";
import { handleKnowledgeWrite, handleKnowledgeRead, handleKnowledgeDelete, handleKnowledgeSearch } from "../src/tools/knowledge.js";
import { updateNode } from "../src/nodes.js";
import { ValidationError, EngineError } from "../src/validate.js";
import { computeContinuityConfidence } from "../src/continuity.js";
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

  it("skip_discovery creates project ready for planning", () => {
    const result = handleOpen({ project: "quick", goal: "Quick project", skip_discovery: true }, AGENT) as any;
    expect(result.root.discovery).toBe("done");
    expect(result.hint).toContain("graph_plan");
    expect(result.hint).not.toContain("Discovery");

    // Should be able to plan immediately
    const plan = handlePlan({ nodes: [{ ref: "a", parent_ref: result.root.id, summary: "Task" }] }, AGENT);
    expect(plan.created).toHaveLength(1);
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

  it("graph_plan allows children when parent has discovery:null (legacy nodes)", () => {
    const { root } = handleOpen({ project: "disc", goal: "Test" }, AGENT) as any;
    // Set discovery to null to simulate a legacy node
    updateNode({ node_id: root.id, agent: AGENT, discovery: null as any });

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
