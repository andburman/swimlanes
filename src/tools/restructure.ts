import { getDb } from "../db.js";
import { getNodeOrThrow, getNode, getChildren, updateNode } from "../nodes.js";
import { getEdgesFrom, getEdgesTo, findNewlyActionable } from "../edges.js";
import { logEvent } from "../events.js";
import type { Evidence } from "../types.js";

export interface MoveOp {
  op: "move";
  node_id: string;
  new_parent: string;
}

export interface MergeOp {
  op: "merge";
  source: string;
  target: string;
}

export interface DropOp {
  op: "drop";
  node_id: string;
  reason: string;
}

export type RestructureOp = MoveOp | MergeOp | DropOp;

export interface RestructureInput {
  operations: RestructureOp[];
}

export interface RestructureResult {
  applied: number;
  details: Array<{ op: string; node_id: string; result: string }>;
  newly_actionable?: Array<{ id: string; summary: string }>;
}

function wouldCreateParentCycle(nodeId: string, newParentId: string): boolean {
  // Check if newParentId is a descendant of nodeId (which would create a cycle)
  const db = getDb();
  let current: string | null = newParentId;

  while (current) {
    if (current === nodeId) return true;
    const row = db
      .prepare("SELECT parent FROM nodes WHERE id = ?")
      .get(current) as { parent: string | null } | undefined;
    current = row?.parent ?? null;
  }

  return false;
}

function getAllDescendants(nodeId: string): string[] {
  const ids: string[] = [];
  const stack = [nodeId];

  while (stack.length > 0) {
    const current = stack.pop()!;
    const children = getChildren(current);
    for (const child of children) {
      ids.push(child.id);
      stack.push(child.id);
    }
  }

  return ids;
}

function handleMove(op: MoveOp, agent: string): { node_id: string; result: string } {
  const db = getDb();
  const node = getNodeOrThrow(op.node_id);
  const newParent = getNodeOrThrow(op.new_parent);

  if (wouldCreateParentCycle(op.node_id, op.new_parent)) {
    throw new Error(
      `Move would create cycle: ${op.node_id} cannot be moved under ${op.new_parent}`
    );
  }

  const oldParent = node.parent;
  db.prepare("UPDATE nodes SET parent = ?, updated_at = ? WHERE id = ?").run(
    op.new_parent,
    new Date().toISOString(),
    op.node_id
  );

  logEvent(op.node_id, agent, "moved", [
    { field: "parent", before: oldParent, after: op.new_parent },
  ]);

  return { node_id: op.node_id, result: `moved under ${op.new_parent}` };
}

function handleMerge(op: MergeOp, agent: string): { node_id: string; result: string } {
  const db = getDb();
  const source = getNodeOrThrow(op.source);
  const target = getNodeOrThrow(op.target);

  // Move source's children to target
  db.prepare("UPDATE nodes SET parent = ?, updated_at = ? WHERE parent = ?").run(
    op.target,
    new Date().toISOString(),
    op.source
  );

  // Append source's evidence to target
  const targetEvidence: Evidence[] = [...target.evidence, ...source.evidence];
  db.prepare("UPDATE nodes SET evidence = ?, updated_at = ? WHERE id = ?").run(
    JSON.stringify(targetEvidence),
    new Date().toISOString(),
    op.target
  );

  // Transfer source's dependency edges to target
  const sourceOutEdges = getEdgesFrom(op.source);
  const sourceInEdges = getEdgesTo(op.source);

  for (const edge of sourceOutEdges) {
    // source depends_on X -> target depends_on X
    const existing = db
      .prepare(
        "SELECT id FROM edges WHERE from_node = ? AND to_node = ? AND type = ?"
      )
      .get(op.target, edge.to_node, edge.type);

    if (!existing) {
      db.prepare(
        "UPDATE edges SET from_node = ? WHERE id = ?"
      ).run(op.target, edge.id);
    } else {
      db.prepare("DELETE FROM edges WHERE id = ?").run(edge.id);
    }
  }

  for (const edge of sourceInEdges) {
    // X depends_on source -> X depends_on target
    const existing = db
      .prepare(
        "SELECT id FROM edges WHERE from_node = ? AND to_node = ? AND type = ?"
      )
      .get(edge.from_node, op.target, edge.type);

    if (!existing) {
      db.prepare(
        "UPDATE edges SET to_node = ? WHERE id = ?"
      ).run(op.target, edge.id);
    } else {
      db.prepare("DELETE FROM edges WHERE id = ?").run(edge.id);
    }
  }

  // Log events
  logEvent(op.target, agent, "merged", [
    { field: "merged_from", before: null, after: op.source },
  ]);
  logEvent(op.source, agent, "merged_into", [
    { field: "merged_into", before: null, after: op.target },
  ]);

  // Delete source node
  db.prepare("DELETE FROM edges WHERE from_node = ? OR to_node = ?").run(
    op.source,
    op.source
  );
  db.prepare("DELETE FROM nodes WHERE id = ?").run(op.source);

  return { node_id: op.target, result: `merged ${op.source} into ${op.target}` };
}

function handleDrop(op: DropOp, agent: string): { node_id: string; result: string } {
  const now = new Date().toISOString();

  // Get all descendants
  const descendants = getAllDescendants(op.node_id);
  const allIds = [op.node_id, ...descendants];

  // Mark all as resolved with evidence
  for (const id of allIds) {
    const node = getNode(id);
    if (!node || node.resolved) continue;

    updateNode({
      node_id: id,
      agent,
      resolved: true,
      add_evidence: [{ type: "dropped", ref: op.reason }],
    });

    logEvent(id, agent, "dropped", [
      { field: "resolved", before: false, after: true },
      { field: "reason", before: null, after: op.reason },
    ]);
  }

  return {
    node_id: op.node_id,
    result: `dropped ${allIds.length} node(s): ${op.reason}`,
  };
}

export function handleRestructure(
  input: RestructureInput,
  agent: string
): RestructureResult {
  const db = getDb();
  let applied = 0;
  const details: Array<{ op: string; node_id: string; result: string }> = [];
  let project: string | null = null;

  const transaction = db.transaction(() => {
    for (const op of input.operations) {
      let detail: { node_id: string; result: string };

      switch (op.op) {
        case "move":
          detail = handleMove(op, agent);
          project = getNode(op.node_id)?.project ?? project;
          break;
        case "merge":
          detail = handleMerge(op, agent);
          project = getNode(op.target)?.project ?? project;
          break;
        case "drop":
          detail = handleDrop(op, agent);
          project = getNode(op.node_id)?.project ?? project;
          break;
        default:
          throw new Error(`Unknown operation: ${(op as RestructureOp).op}`);
      }

      details.push({ op: op.op, ...detail });
      applied++;
    }
  });

  transaction();

  const result: RestructureResult = { applied, details };

  if (project) {
    const actionable = findNewlyActionable(project);
    if (actionable.length > 0) {
      result.newly_actionable = actionable;
    }
  }

  return result;
}
