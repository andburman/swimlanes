import { updateNode, getNode, getNodeOrThrow, getChildren } from "../nodes.js";
import { findNewlyActionable } from "../edges.js";
import { requireArray, requireString, EngineError } from "../validate.js";

export interface UpdateEntry {
  node_id: string;
  expected_rev?: number;
  resolved?: boolean;
  resolved_reason?: string; // [sl:QBEtldx8PBWACftEM8MYl] Shorthand — auto-creates note evidence
  discovery?: string | null;
  state?: unknown;
  summary?: string;
  properties?: Record<string, unknown>;
  add_context_links?: string[];
  remove_context_links?: string[];
  add_evidence?: Array<{ type: string; ref: string }>;
}

export interface UpdateInput {
  updates: UpdateEntry[];
}

export interface UpdateResult {
  updated: Array<{ node_id: string; rev: number }>;
  newly_actionable?: Array<{ id: string; summary: string }>;
  auto_resolved?: Array<{ node_id: string; summary: string }>;
}

export function handleUpdate(input: UpdateInput, agent: string): UpdateResult {
  const updates = requireArray<UpdateEntry>(input?.updates, "updates");

  for (let i = 0; i < updates.length; i++) {
    requireString(updates[i].node_id, `updates[${i}].node_id`);
    if (updates[i].add_evidence) {
      for (let j = 0; j < updates[i].add_evidence!.length; j++) {
        requireString(updates[i].add_evidence![j].type, `updates[${i}].add_evidence[${j}].type`);
        requireString(updates[i].add_evidence![j].ref, `updates[${i}].add_evidence[${j}].ref`);
      }
    }
  }

  const updated: Array<{ node_id: string; rev: number }> = [];
  const resolvedIds: string[] = [];
  const resolvedProjects = new Set<string>();

  for (const entry of updates) {
    // Optimistic concurrency: reject if rev doesn't match
    if (entry.expected_rev !== undefined) {
      const current = getNodeOrThrow(entry.node_id);
      if (current.rev !== entry.expected_rev) {
        throw new EngineError(
          "rev_mismatch",
          `Node ${entry.node_id} has rev ${current.rev}, expected ${entry.expected_rev}. Another agent may have modified it. Re-read and retry.`
        );
      }
    }

    // Expand resolved_reason shorthand into evidence
    let evidence = entry.add_evidence;
    if (entry.resolved_reason) {
      evidence = [...(evidence ?? []), { type: "note", ref: entry.resolved_reason }];
    }

    const node = updateNode({
      node_id: entry.node_id,
      agent,
      resolved: entry.resolved,
      discovery: entry.discovery,
      state: entry.state,
      summary: entry.summary,
      properties: entry.properties,
      add_context_links: entry.add_context_links,
      remove_context_links: entry.remove_context_links,
      add_evidence: evidence,
    });

    updated.push({ node_id: node.id, rev: node.rev });

    if (entry.resolved === true) {
      resolvedIds.push(node.id);
      resolvedProjects.add(node.project);
    }
  }

  // [sl:GBuFbmTFuFfnl5KWW-ja-] Auto-resolve parents when all children are resolved
  const autoResolved: Array<{ node_id: string; summary: string }> = [];
  if (resolvedIds.length > 0) {
    const seen = new Set<string>(resolvedIds);
    const queue = [...resolvedIds];

    while (queue.length > 0) {
      const nodeId = queue.shift()!;
      const node = getNode(nodeId);
      if (!node?.parent) continue;

      const parentId = node.parent;
      if (seen.has(parentId)) continue;
      seen.add(parentId);

      const parent = getNode(parentId);
      if (!parent || parent.resolved) continue;

      const children = getChildren(parentId);
      if (children.length === 0) continue;
      if (children.every((c) => c.resolved)) {
        const resolved = updateNode({
          node_id: parentId,
          agent,
          resolved: true,
          add_evidence: [{ type: "note", ref: "Auto-resolved: all children completed" }],
        });
        updated.push({ node_id: resolved.id, rev: resolved.rev });
        resolvedIds.push(parentId);
        autoResolved.push({ node_id: parentId, summary: parent.summary });
        queue.push(parentId);
      }
    }
  }

  const result: UpdateResult = { updated };

  if (resolvedIds.length > 0 && resolvedProjects.size > 0) {
    const allActionable: Array<{ id: string; summary: string }> = [];
    for (const proj of resolvedProjects) {
      allActionable.push(...findNewlyActionable(proj, resolvedIds));
    }
    result.newly_actionable = allActionable;
  }

  if (autoResolved.length > 0) {
    result.auto_resolved = autoResolved;
  }

  return result;
}
