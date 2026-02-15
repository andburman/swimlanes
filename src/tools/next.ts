import { getDb } from "../db.js";
import { getNode, getAncestors, updateNode } from "../nodes.js";
import { getEdgesFrom } from "../edges.js";
import { requireString, optionalNumber, optionalBoolean } from "../validate.js";
import type { Node, NodeRow, Evidence } from "../types.js";

export interface NextInput {
  project: string;
  filter?: Record<string, unknown>;
  count?: number;
  claim?: boolean;
}

export interface NextResultNode {
  node: Node;
  ancestors: Array<{ id: string; summary: string }>;
  context_links: {
    self: string[];
    inherited: Array<{ node_id: string; links: string[] }>;
  };
  resolved_deps: Array<{
    id: string;
    summary: string;
    evidence: Evidence[];
  }>;
}

export interface NextResult {
  nodes: NextResultNode[];
}

export function handleNext(
  input: NextInput,
  agent: string,
  claimTtlMinutes: number = 60
): NextResult {
  const project = requireString(input?.project, "project");
  const count = optionalNumber(input?.count, "count", 1, 50) ?? 1;
  const claim = optionalBoolean(input?.claim, "claim") ?? false;
  const db = getDb();

  // Find actionable nodes: unresolved, leaf (no unresolved children), all deps resolved
  let query = `
    SELECT n.* FROM nodes n
    WHERE n.project = ? AND n.resolved = 0
    AND NOT EXISTS (
      SELECT 1 FROM nodes child WHERE child.parent = n.id AND child.resolved = 0
    )
    AND NOT EXISTS (
      SELECT 1 FROM edges e
      JOIN nodes dep ON dep.id = e.to_node AND dep.resolved = 0
      WHERE e.from_node = n.id AND e.type = 'depends_on'
    )
  `;

  const params: unknown[] = [project];

  // Skip nodes claimed by other agents (if claim TTL hasn't expired)
  const claimCutoff = new Date(
    Date.now() - claimTtlMinutes * 60 * 1000
  ).toISOString();

  query += `
    AND (
      json_extract(n.properties, '$._claimed_by') IS NULL
      OR json_extract(n.properties, '$._claimed_by') = ?
      OR json_extract(n.properties, '$._claimed_at') <= ?
    )
  `;
  params.push(agent, claimCutoff);

  // Property filters
  if (input.filter) {
    for (const [key, value] of Object.entries(input.filter)) {
      query += " AND json_extract(n.properties, ?) = ?";
      params.push(`$.${key}`, value as string | number);
    }
  }

  // [sl:md48WyMYFlOf4KP99vmtv] Ranking fully in SQL — never loads more than N rows
  // Depth is cached on the node, priority extracted via json_extract
  query += `
    ORDER BY
      COALESCE(CAST(json_extract(n.properties, '$.priority') AS REAL), 0) DESC,
      n.depth DESC,
      n.updated_at ASC
    LIMIT ?
  `;
  params.push(count);

  const rows = db.prepare(query).all(...params) as NodeRow[];

  const selected = rows.map((row) => ({ row }));

  const results: NextResultNode[] = selected.map(({ row }) => {
    const node = getNode(row.id)!;
    const ancestors = getAncestors(row.id);

    // Context links: self + inherited from ancestors
    const inherited: Array<{ node_id: string; links: string[] }> = [];
    for (const anc of ancestors) {
      const ancNode = getNode(anc.id);
      if (ancNode && ancNode.context_links.length > 0) {
        inherited.push({ node_id: anc.id, links: ancNode.context_links });
      }
    }

    // Resolved dependencies
    const depEdges = getEdgesFrom(row.id, "depends_on");
    const resolved_deps = depEdges
      .map((edge) => {
        const depNode = getNode(edge.to_node);
        if (!depNode || !depNode.resolved) return null;
        return {
          id: depNode.id,
          summary: depNode.summary,
          evidence: depNode.evidence,
        };
      })
      .filter(Boolean) as NextResultNode["resolved_deps"];

    // Claim if requested
    if (claim) {
      updateNode({
        node_id: node.id,
        agent,
        properties: {
          _claimed_by: agent,
          _claimed_at: new Date().toISOString(),
        },
      });
    }

    return {
      node: claim ? getNode(row.id)! : node,
      ancestors: ancestors.map((a) => ({ id: a.id, summary: a.summary })),
      context_links: {
        self: node.context_links,
        inherited,
      },
      resolved_deps,
    };
  });

  return { nodes: results };
}
