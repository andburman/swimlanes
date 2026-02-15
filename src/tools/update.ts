import { updateNode } from "../nodes.js";
import { findNewlyActionable } from "../edges.js";
import { requireArray, requireString } from "../validate.js";

export interface UpdateEntry {
  node_id: string;
  resolved?: boolean;
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
  let project: string | null = null;

  for (const entry of updates) {
    const node = updateNode({
      node_id: entry.node_id,
      agent,
      resolved: entry.resolved,
      state: entry.state,
      summary: entry.summary,
      properties: entry.properties,
      add_context_links: entry.add_context_links,
      remove_context_links: entry.remove_context_links,
      add_evidence: entry.add_evidence,
    });

    updated.push({ node_id: node.id, rev: node.rev });

    if (entry.resolved === true) {
      resolvedIds.push(node.id);
      project = node.project;
    }
  }

  const result: UpdateResult = { updated };

  if (resolvedIds.length > 0 && project) {
    result.newly_actionable = findNewlyActionable(project, resolvedIds);
  }

  return result;
}
