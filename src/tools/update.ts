import { updateNode } from "../nodes.js";
import { findNewlyActionable } from "../edges.js";
import { getNode } from "../nodes.js";

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
  const updated: Array<{ node_id: string; rev: number }> = [];
  let anyResolved = false;
  let project: string | null = null;

  for (const entry of input.updates) {
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
      anyResolved = true;
      project = node.project;
    }
  }

  const result: UpdateResult = { updated };

  if (anyResolved && project) {
    result.newly_actionable = findNewlyActionable(project);
  }

  return result;
}
