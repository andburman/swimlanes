import { getDb } from "../db.js";
import { getNode, getAncestors, updateNode } from "../nodes.js";
import { getEdgesFrom } from "../edges.js";
import { requireString, optionalString, optionalNumber, optionalBoolean } from "../validate.js";
import type { Node, NodeRow, Evidence } from "../types.js";

export interface NextInput {
  project: string;
  scope?: string;
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

export interface ClaimedTask {
  id: string;
  summary: string;
  claimed_at: string;
}

// [sl:QKuJkdiYUncO6_YVhbJ73] Verification checkpoints
export interface PendingVerification {
  id: string;
  summary: string;
  flagged_at: string;
}

export interface NextResult {
  nodes: NextResultNode[];
  your_claims?: ClaimedTask[];
  pending_verification?: PendingVerification[];
  auto_scoped?: { parent_id: string; parent_summary: string };
  retro_nudge?: string;
}

export function handleNext(
  input: NextInput,
  agent: string,
  claimTtlMinutes: number = 60
): NextResult {
  const project = requireString(input?.project, "project");
  const scope = optionalString(input?.scope, "scope");
  const count = optionalNumber(input?.count, "count", 1, 50) ?? 1;
  const claim = optionalBoolean(input?.claim, "claim") ?? false;
  const db = getDb();

  // [sl:Ufz48Frf4aeXz9ztEODKE] Auto-scope: if agent has an active claim, scope to that claim's parent
  let effectiveScope = scope;
  let autoScoped = false;
  if (!scope) {
    const claimCutoff_ = new Date(Date.now() - claimTtlMinutes * 60 * 1000).toISOString();
    const recentClaim = db.prepare(
      `SELECT parent FROM nodes
       WHERE project = ?
       AND json_extract(properties, '$._claimed_by') = ?
       AND json_extract(properties, '$._claimed_at') > ?
       AND parent IS NOT NULL
       ORDER BY json_extract(properties, '$._claimed_at') DESC
       LIMIT 1`
    ).get(project, agent, claimCutoff_) as { parent: string } | undefined;

    if (recentClaim) {
      effectiveScope = recentClaim.parent;
      autoScoped = true;
    }
  }

  // [sl:HB5daFH1HlFXzuTluibnk] Scope filtering: restrict to descendants of a given node
  let scopeFilter = "";
  const scopeParams: unknown[] = [];
  if (effectiveScope) {
    const descendantIds = db
      .prepare(
        `WITH RECURSIVE descendants(id) AS (
          SELECT id FROM nodes WHERE parent = ?
          UNION ALL
          SELECT n.id FROM nodes n JOIN descendants d ON n.parent = d.id
        )
        SELECT id FROM descendants`
      )
      .all(effectiveScope) as Array<{ id: string }>;

    if (descendantIds.length === 0) {
      return { nodes: [] };
    }
    scopeFilter = `AND n.id IN (${descendantIds.map(() => "?").join(",")})`;
    scopeParams.push(...descendantIds.map((d) => d.id));
  }

  // Find actionable nodes: unresolved, not blocked, leaf (no unresolved children), all deps resolved
  let query = `
    SELECT n.* FROM nodes n
    WHERE n.project = ? AND n.resolved = 0 AND n.blocked = 0
    ${scopeFilter}
    AND NOT EXISTS (
      SELECT 1 FROM nodes child WHERE child.parent = n.id AND child.resolved = 0
    )
    AND NOT EXISTS (
      SELECT 1 FROM edges e
      JOIN nodes dep ON dep.id = e.to_node AND dep.resolved = 0
      WHERE e.from_node = n.id AND e.type = 'depends_on'
    )
  `;

  const params: unknown[] = [project, ...scopeParams];

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

  // Surface caller's existing claims (unexpired) so they can resume or release them
  const claimRows = db
    .prepare(
      `SELECT id, summary, json_extract(properties, '$._claimed_at') as claimed_at
       FROM nodes
       WHERE project = ? AND resolved = 0
       AND json_extract(properties, '$._claimed_by') = ?
       AND json_extract(properties, '$._claimed_at') > ?
       ORDER BY json_extract(properties, '$._claimed_at') DESC`
    )
    .all(project, agent, claimCutoff) as Array<{ id: string; summary: string; claimed_at: string }>;

  const result: NextResult = { nodes: results };
  if (autoScoped && effectiveScope) {
    const scopeNode = getNode(effectiveScope);
    if (scopeNode) {
      result.auto_scoped = { parent_id: scopeNode.id, parent_summary: scopeNode.summary };
    }
  }
  if (claimRows.length > 0) {
    result.your_claims = claimRows.map((r) => ({
      id: r.id,
      summary: r.summary,
      claimed_at: r.claimed_at,
    }));
  }

  // [sl:QKuJkdiYUncO6_YVhbJ73] Surface nodes pending human verification
  const verificationRows = db
    .prepare(
      `SELECT id, summary, json_extract(properties, '$._needs_verification') as flagged_at
       FROM nodes
       WHERE project = ? AND resolved = 0
       AND json_extract(properties, '$._needs_verification') IS NOT NULL
       AND json_extract(properties, '$._needs_verification') != 'false'
       ORDER BY updated_at ASC`
    )
    .all(project) as Array<{ id: string; summary: string; flagged_at: string }>;

  if (verificationRows.length > 0) {
    result.pending_verification = verificationRows.map((r) => ({
      id: r.id,
      summary: r.summary,
      flagged_at: typeof r.flagged_at === "string" ? r.flagged_at : "true",
    }));
  }

  // [sl:ZlreTpaeFU0SvfjJysR9k] Retro nudge when N tasks resolved since last retro
  const RETRO_THRESHOLD = 5;
  const lastRetro = db.prepare(
    "SELECT updated_at FROM knowledge WHERE project = ? AND key LIKE 'retro-%' ORDER BY updated_at DESC LIMIT 1"
  ).get(project) as { updated_at: string } | undefined;
  const sinceDate = lastRetro?.updated_at ?? "1970-01-01T00:00:00.000Z";
  const resolvedSince = (db.prepare(
    "SELECT COUNT(*) as cnt FROM nodes WHERE project = ? AND resolved = 1 AND parent IS NOT NULL AND updated_at > ?"
  ).get(project, sinceDate) as { cnt: number }).cnt;

  if (resolvedSince >= RETRO_THRESHOLD) {
    result.retro_nudge = `${resolvedSince} task(s) resolved since last retro. Consider running graph_retro({ project: "${project}" }) to capture insights.`;
  }

  return result;
}
