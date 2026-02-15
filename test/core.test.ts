import { describe, it, expect, beforeEach } from "vitest";
import { initDb, closeDb } from "../src/db.js";
import {
  createNode,
  getNode,
  getNodeOrThrow,
  getChildren,
  getAncestors,
  getProjectRoot,
  listProjects,
  updateNode,
  getProjectSummary,
} from "../src/nodes.js";
import {
  addEdge,
  removeEdge,
  getEdgesFrom,
  getEdgesTo,
  findNewlyActionable,
} from "../src/edges.js";
import { getEvents } from "../src/events.js";
import { EngineError, ValidationError } from "../src/validate.js";

beforeEach(() => {
  initDb(":memory:");
});

// --- Nodes ---

describe("nodes", () => {
  it("creates and retrieves a node", () => {
    const node = createNode({ project: "p1", summary: "Root", agent: "test" });
    expect(node.id).toBeTruthy();
    expect(node.summary).toBe("Root");
    expect(node.resolved).toBe(false);
    expect(node.rev).toBe(1);

    const fetched = getNode(node.id);
    expect(fetched).toEqual(node);
  });

  it("creates parent-child relationships", () => {
    const root = createNode({ project: "p1", summary: "Root", agent: "test" });
    const child = createNode({ project: "p1", parent: root.id, summary: "Child", agent: "test" });

    const children = getChildren(root.id);
    expect(children).toHaveLength(1);
    expect(children[0].id).toBe(child.id);
  });

  it("computes ancestor chain", () => {
    const root = createNode({ project: "p1", summary: "Root", agent: "test" });
    const mid = createNode({ project: "p1", parent: root.id, summary: "Mid", agent: "test" });
    const leaf = createNode({ project: "p1", parent: mid.id, summary: "Leaf", agent: "test" });

    const ancestors = getAncestors(leaf.id);
    expect(ancestors).toHaveLength(2);
    expect(ancestors[0].summary).toBe("Root");
    expect(ancestors[1].summary).toBe("Mid");
  });

  it("finds project root", () => {
    const root = createNode({ project: "p1", summary: "Root", agent: "test" });
    createNode({ project: "p1", parent: root.id, summary: "Child", agent: "test" });

    const found = getProjectRoot("p1");
    expect(found?.id).toBe(root.id);
  });

  it("lists projects with counts", () => {
    const r1 = createNode({ project: "p1", summary: "Project 1", agent: "test" });
    createNode({ project: "p1", parent: r1.id, summary: "Task", agent: "test" });
    createNode({ project: "p2", summary: "Project 2", agent: "test" });

    const projects = listProjects();
    expect(projects).toHaveLength(2);
    const p1 = projects.find((p) => p.summary === "Project 1")!;
    expect(p1.total).toBe(2);
    expect(p1.resolved).toBe(0);
  });

  it("updates a node", () => {
    const node = createNode({ project: "p1", summary: "Task", agent: "test" });

    const updated = updateNode({
      node_id: node.id,
      agent: "test",
      resolved: true,
      summary: "Updated Task",
      properties: { priority: 5 },
      add_context_links: ["file.ts"],
      add_evidence: [{ type: "git", ref: "abc123" }],
    });

    expect(updated.rev).toBe(2);
    expect(updated.resolved).toBe(true);
    expect(updated.summary).toBe("Updated Task");
    expect(updated.properties).toEqual({ priority: 5 });
    expect(updated.context_links).toEqual(["file.ts"]);
    expect(updated.evidence).toHaveLength(1);
    expect(updated.evidence[0].type).toBe("git");
  });

  it("merges properties without replacing", () => {
    const node = createNode({
      project: "p1",
      summary: "Task",
      agent: "test",
      properties: { a: 1, b: 2 },
    });

    const updated = updateNode({
      node_id: node.id,
      agent: "test",
      properties: { b: 3, c: 4 },
    });

    expect(updated.properties).toEqual({ a: 1, b: 3, c: 4 });
  });

  it("deletes properties with null", () => {
    const node = createNode({
      project: "p1",
      summary: "Task",
      agent: "test",
      properties: { a: 1, b: 2 },
    });

    const updated = updateNode({
      node_id: node.id,
      agent: "test",
      properties: { a: null },
    });

    expect(updated.properties).toEqual({ b: 2 });
  });

  it("throws EngineError for missing node", () => {
    expect(() => getNodeOrThrow("nonexistent")).toThrow(EngineError);
  });

  it("computes project summary", () => {
    const root = createNode({ project: "p1", summary: "Root", agent: "test" });
    const t1 = createNode({ project: "p1", parent: root.id, summary: "T1", agent: "test" });
    const t2 = createNode({ project: "p1", parent: root.id, summary: "T2", agent: "test" });

    // t2 depends on t1
    addEdge({ from: t2.id, to: t1.id, type: "depends_on", agent: "test" });

    const summary = getProjectSummary("p1");
    expect(summary.total).toBe(3);
    expect(summary.unresolved).toBe(3);
    expect(summary.blocked).toBe(1); // t2
    expect(summary.actionable).toBe(1); // t1
  });
});

// --- Edges ---

describe("edges", () => {
  it("creates and queries edges", () => {
    const a = createNode({ project: "p1", summary: "A", agent: "test" });
    const b = createNode({ project: "p1", summary: "B", agent: "test" });

    addEdge({ from: a.id, to: b.id, type: "depends_on", agent: "test" });

    const from = getEdgesFrom(a.id, "depends_on");
    expect(from).toHaveLength(1);
    expect(from[0].to_node).toBe(b.id);

    const to = getEdgesTo(b.id, "depends_on");
    expect(to).toHaveLength(1);
    expect(to[0].from_node).toBe(a.id);
  });

  it("detects direct cycles", () => {
    const a = createNode({ project: "p1", summary: "A", agent: "test" });
    const b = createNode({ project: "p1", summary: "B", agent: "test" });

    addEdge({ from: a.id, to: b.id, type: "depends_on", agent: "test" });
    const result = addEdge({ from: b.id, to: a.id, type: "depends_on", agent: "test" });

    expect(result.rejected).toBe(true);
    expect(result.reason).toBe("cycle_detected");
  });

  it("detects transitive cycles", () => {
    const a = createNode({ project: "p1", summary: "A", agent: "test" });
    const b = createNode({ project: "p1", summary: "B", agent: "test" });
    const c = createNode({ project: "p1", summary: "C", agent: "test" });

    addEdge({ from: a.id, to: b.id, type: "depends_on", agent: "test" });
    addEdge({ from: b.id, to: c.id, type: "depends_on", agent: "test" });
    const result = addEdge({ from: c.id, to: a.id, type: "depends_on", agent: "test" });

    expect(result.rejected).toBe(true);
    expect(result.reason).toBe("cycle_detected");
  });

  it("rejects duplicate edges", () => {
    const a = createNode({ project: "p1", summary: "A", agent: "test" });
    const b = createNode({ project: "p1", summary: "B", agent: "test" });

    addEdge({ from: a.id, to: b.id, type: "depends_on", agent: "test" });
    const result = addEdge({ from: a.id, to: b.id, type: "depends_on", agent: "test" });

    expect(result.rejected).toBe(true);
    expect(result.reason).toBe("duplicate_edge");
  });

  it("removes edges", () => {
    const a = createNode({ project: "p1", summary: "A", agent: "test" });
    const b = createNode({ project: "p1", summary: "B", agent: "test" });

    addEdge({ from: a.id, to: b.id, type: "depends_on", agent: "test" });
    const removed = removeEdge(a.id, b.id, "depends_on", "test");
    expect(removed).toBe(true);

    const edges = getEdgesFrom(a.id, "depends_on");
    expect(edges).toHaveLength(0);
  });

  it("finds newly actionable nodes", () => {
    const root = createNode({ project: "p1", summary: "Root", agent: "test" });
    const t1 = createNode({ project: "p1", parent: root.id, summary: "T1", agent: "test" });
    const t2 = createNode({ project: "p1", parent: root.id, summary: "T2", agent: "test" });

    addEdge({ from: t2.id, to: t1.id, type: "depends_on", agent: "test" });

    // Before resolving t1, only t1 is actionable
    let actionable = findNewlyActionable("p1");
    expect(actionable.map((n) => n.summary)).toContain("T1");
    expect(actionable.map((n) => n.summary)).not.toContain("T2");

    // Resolve t1
    updateNode({ node_id: t1.id, agent: "test", resolved: true, add_evidence: [{ type: "test", ref: "done" }] });

    // Now t2 is actionable
    actionable = findNewlyActionable("p1");
    expect(actionable.map((n) => n.summary)).toContain("T2");
  });
});

// --- Events ---

describe("events", () => {
  it("logs creation and update events", () => {
    const node = createNode({ project: "p1", summary: "Task", agent: "test" });
    updateNode({ node_id: node.id, agent: "test", resolved: true, add_evidence: [{ type: "test", ref: "done" }] });

    const { events } = getEvents(node.id);
    expect(events).toHaveLength(2);
    const actions = events.map((e) => e.action).sort();
    expect(actions).toEqual(["created", "resolved"]);
  });

  it("supports pagination", () => {
    const node = createNode({ project: "p1", summary: "Task", agent: "test" });
    // Create several updates
    for (let i = 0; i < 5; i++) {
      updateNode({ node_id: node.id, agent: "test", properties: { step: i } });
    }

    // Total: 6 events (1 created + 5 updated)
    const all = getEvents(node.id, 100);
    expect(all.events.length).toBe(6);

    const page1 = getEvents(node.id, 3);
    expect(page1.events).toHaveLength(3);
    expect(page1.next_cursor).toBeTruthy();
  });
});
