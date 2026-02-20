import { getDb } from "../db.js";
import { getNodeOrThrow, getNode, getChildren, updateNode } from "../nodes.js";
import { getEdgesFrom, getEdgesTo, findNewlyActionable } from "../edges.js";
import { logEvent } from "../events.js";
import { requireArray, requireString, EngineError } from "../validate.js";
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

export interface DeleteOp {
  op: "delete";
  node_id: string;
}

export type RestructureOp = MoveOp | MergeOp | DropOp | DeleteOp;

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

function recomputeSubtreeDepth(nodeId: string, newDepth: number): void {
  const db = getDb();
  db.prepare("UPDATE nodes SET depth = ? WHERE id = ?").run(newDepth, nodeId);
  const children = db.prepare("SELECT id FROM nodes WHERE parent = ?").all(nodeId) as Array<{ id: string }>;
  for (const child of children) {
    recomputeSubtreeDepth(child.id, newDepth + 1);
  }
}

function handleMove(op: MoveOp, agent: string): { node_id: string; result: string } {
  const db = getDb();
  const node = getNodeOrThrow(op.node_id);
  const newParent = getNodeOrThrow(op.new_parent);

  if (node.project !== newParent.project) {
    throw new EngineError("cross_project", `Cannot move node across projects: "${node.project}" → "${newParent.project}"`);
  }

  if (wouldCreateParentCycle(op.node_id, op.new_parent)) {
    throw new EngineError(
      "cycle_detected",
      `Move would create cycle: ${op.node_id} cannot be moved under ${op.new_parent}`
    );
  }

  const oldParent = node.parent;
  const now = new Date().toISOString();
  db.prepare("UPDATE nodes SET parent = ?, updated_at = ? WHERE id = ?").run(
    op.new_parent,
    now,
    op.node_id
  );

  // Recompute depth for moved node and all descendants
  recomputeSubtreeDepth(op.node_id, newParent.depth + 1);

  logEvent(op.node_id, agent, "moved", [
    { field: "parent", before: oldParent, after: op.new_parent },
  ]);

  return { node_id: op.node_id, result: `moved under ${op.new_parent}` };
}

function handleMerge(op: MergeOp, agent: string): { node_id: string; result: string } {
  const db = getDb();
  const source = getNodeOrThrow(op.source);
  const target = getNodeOrThrow(op.target);

  if (source.project !== target.project) {
    throw new EngineError("cross_project", `Cannot merge nodes across projects: "${source.project}" → "${target.project}"`);
  }

  // Move source's children to target and recompute their depths
  const movedChildren = db.prepare("SELECT id FROM nodes WHERE parent = ?").all(op.source) as Array<{ id: string }>;
  db.prepare("UPDATE nodes SET parent = ?, updated_at = ? WHERE parent = ?").run(
    op.target,
    new Date().toISOString(),
    op.source
  );
  for (const child of movedChildren) {
    recomputeSubtreeDepth(child.id, target.depth + 1);
  }

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

  // Log merge on target (source will be deleted)
  logEvent(op.target, agent, "merged", [
    { field: "merged_from", before: null, after: op.source },
  ]);

  // Delete source: events, edges, then node (FK order)
  db.prepare("DELETE FROM events WHERE node_id = ?").run(op.source);
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

function handleDelete(op: DeleteOp, agent: string): { node_id: string; result: string } {
  const db = getDb();
  getNodeOrThrow(op.node_id);

  const descendants = getAllDescendants(op.node_id);
  const allIds = [op.node_id, ...descendants];
  const placeholders = allIds.map(() => "?").join(",");

  // Delete events, edges, then nodes (FK order)
  db.prepare(`DELETE FROM events WHERE node_id IN (${placeholders})`).run(...allIds);
  db.prepare(`DELETE FROM edges WHERE from_node IN (${placeholders}) OR to_node IN (${placeholders})`).run(...allIds, ...allIds);
  db.prepare(`DELETE FROM nodes WHERE id IN (${placeholders})`).run(...allIds);

  return {
    node_id: op.node_id,
    result: `deleted ${allIds.length} node(s)`,
  };
}

export function handleRestructure(
  input: RestructureInput,
  agent: string
): RestructureResult {
  const operations = requireArray<RestructureOp>(input?.operations, "operations");

  for (let i = 0; i < operations.length; i++) {
    const op = operations[i];
    requireString(op.op, `operations[${i}].op`);
    if (op.op === "move") {
      requireString((op as MoveOp).node_id, `operations[${i}].node_id`);
      requireString((op as MoveOp).new_parent, `operations[${i}].new_parent`);
    } else if (op.op === "merge") {
      requireString((op as MergeOp).source, `operations[${i}].source`);
      requireString((op as MergeOp).target, `operations[${i}].target`);
    } else if (op.op === "drop") {
      requireString((op as DropOp).node_id, `operations[${i}].node_id`);
      requireString((op as DropOp).reason, `operations[${i}].reason`);
    } else if (op.op === "delete") {
      requireString((op as DeleteOp).node_id, `operations[${i}].node_id`);
    } else {
      throw new EngineError("unknown_op", `Unknown operation: ${op.op}`);
    }
  }

  const db = getDb();
  let applied = 0;
  const details: Array<{ op: string; node_id: string; result: string }> = [];
  let project: string | null = null;

  const transaction = db.transaction(() => {
    for (const op of operations) {
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
        case "delete":
          project = getNode(op.node_id)?.project ?? project;
          detail = handleDelete(op, agent);
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
