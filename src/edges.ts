import { nanoid } from "nanoid";
import { getDb } from "./db.js";
import { logEvent } from "./events.js";
import type { Edge } from "./types.js";

// --- Cycle detection ---

function wouldCreateCycle(from: string, to: string): boolean {
  // Adding edge "from depends_on to". Check if to can already reach from
  // through existing depends_on edges. If so, adding this edge creates a cycle.
  const db = getDb();
  const visited = new Set<string>();
  const stack = [to];

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === from) return true;
    if (visited.has(current)) continue;
    visited.add(current);

    // Follow forward depends_on edges: what does current depend on?
    const deps = db
      .prepare(
        `SELECT to_node FROM edges WHERE from_node = ? AND type = 'depends_on'`
      )
      .all(current) as Array<{ to_node: string }>;

    for (const dep of deps) {
      stack.push(dep.to_node);
    }
  }

  return false;
}

// --- Add edge ---

export interface AddEdgeInput {
  from: string;
  to: string;
  type: string;
  agent: string;
}

export interface AddEdgeResult {
  edge: Edge | null;
  rejected: boolean;
  reason?: string;
}

export function addEdge(input: AddEdgeInput): AddEdgeResult {
  const db = getDb();

  // Check nodes exist
  const fromExists = db.prepare("SELECT id FROM nodes WHERE id = ?").get(input.from);
  const toExists = db.prepare("SELECT id FROM nodes WHERE id = ?").get(input.to);

  if (!fromExists) {
    return { edge: null, rejected: true, reason: "node_not_found: " + input.from };
  }
  if (!toExists) {
    return { edge: null, rejected: true, reason: "node_not_found: " + input.to };
  }

  // Check for duplicates
  const existing = db
    .prepare(
      "SELECT id FROM edges WHERE from_node = ? AND to_node = ? AND type = ?"
    )
    .get(input.from, input.to, input.type);

  if (existing) {
    return { edge: null, rejected: true, reason: "duplicate_edge" };
  }

  // Cycle detection for depends_on
  if (input.type === "depends_on") {
    if (wouldCreateCycle(input.from, input.to)) {
      return { edge: null, rejected: true, reason: "cycle_detected" };
    }
  }

  const edge: Edge = {
    id: nanoid(),
    from_node: input.from,
    to_node: input.to,
    type: input.type,
    created_at: new Date().toISOString(),
  };

  db.prepare(`
    INSERT INTO edges (id, from_node, to_node, type, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(edge.id, edge.from_node, edge.to_node, edge.type, edge.created_at);

  logEvent(input.from, input.agent, "edge_added", [
    { field: "edge", before: null, after: { to: input.to, type: input.type } },
  ]);

  return { edge, rejected: false };
}

// --- Remove edge ---

export function removeEdge(
  from: string,
  to: string,
  type: string,
  agent: string
): boolean {
  const db = getDb();

  const result = db
    .prepare(
      "DELETE FROM edges WHERE from_node = ? AND to_node = ? AND type = ?"
    )
    .run(from, to, type);

  if (result.changes > 0) {
    logEvent(from, agent, "edge_removed", [
      { field: "edge", before: { to, type }, after: null },
    ]);
    return true;
  }

  return false;
}

// --- Query edges ---

export function getEdgesFrom(nodeId: string, type?: string): Edge[] {
  const db = getDb();

  if (type) {
    return db
      .prepare("SELECT * FROM edges WHERE from_node = ? AND type = ?")
      .all(nodeId, type) as Edge[];
  }

  return db
    .prepare("SELECT * FROM edges WHERE from_node = ?")
    .all(nodeId) as Edge[];
}

export function getEdgesTo(nodeId: string, type?: string): Edge[] {
  const db = getDb();

  if (type) {
    return db
      .prepare("SELECT * FROM edges WHERE to_node = ? AND type = ?")
      .all(nodeId, type) as Edge[];
  }

  return db
    .prepare("SELECT * FROM edges WHERE to_node = ?")
    .all(nodeId) as Edge[];
}

// [sl:uRocbNC_bArUXGr908Qbk] Find newly actionable nodes
// Targeted: accepts resolved node IDs, checks only direct dependents.
// Falls back to project-wide scan when no IDs provided.

export function findNewlyActionable(
  project: string,
  resolvedNodeIds?: string[]
): Array<{ id: string; summary: string }> {
  const db = getDb();

  if (resolvedNodeIds && resolvedNodeIds.length > 0) {
    // Targeted: only check direct dependents of the resolved nodes + children of resolved nodes
    const placeholders = resolvedNodeIds.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT DISTINCT n.id, n.summary FROM nodes n
         WHERE n.resolved = 0 AND n.project = ?
         AND (
           -- nodes that had a depends_on edge to one of the resolved nodes
           n.id IN (
             SELECT e.from_node FROM edges e
             WHERE e.type = 'depends_on' AND e.to_node IN (${placeholders})
           )
           OR
           -- parents of resolved nodes (might now be leaf if all children resolved)
           n.id IN (SELECT parent FROM nodes WHERE id IN (${placeholders}) AND parent IS NOT NULL)
         )
         -- is a leaf (no unresolved children)
         AND NOT EXISTS (
           SELECT 1 FROM nodes child WHERE child.parent = n.id AND child.resolved = 0
         )
         -- all deps resolved
         AND NOT EXISTS (
           SELECT 1 FROM edges e
           JOIN nodes dep ON dep.id = e.to_node AND dep.resolved = 0
           WHERE e.from_node = n.id AND e.type = 'depends_on'
         )`
      )
      .all(project, ...resolvedNodeIds, ...resolvedNodeIds) as Array<{
      id: string;
      summary: string;
    }>;

    return rows;
  }

  // Fallback: project-wide scan
  const rows = db
    .prepare(
      `SELECT n.id, n.summary FROM nodes n
       WHERE n.project = ? AND n.resolved = 0
       AND NOT EXISTS (
         SELECT 1 FROM nodes child WHERE child.parent = n.id AND child.resolved = 0
       )
       AND NOT EXISTS (
         SELECT 1 FROM edges e
         JOIN nodes dep ON dep.id = e.to_node AND dep.resolved = 0
         WHERE e.from_node = n.id AND e.type = 'depends_on'
       )`
    )
    .all(project) as Array<{ id: string; summary: string }>;

  return rows;
}
