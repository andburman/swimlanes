import { getDb } from "../db.js";
import { getProjectRoot, getProjectSummary } from "../nodes.js";
import { requireString, optionalNumber } from "../validate.js";
import { EngineError } from "../validate.js";
import type { NodeRow, Evidence } from "../types.js";

// [sl:yosc4NuV6j43Zv0fsDXDj] graph_onboard — single-call orientation for new agents

export interface OnboardInput {
  project: string;
  evidence_limit?: number;
}

export interface OnboardResult {
  project: string;
  summary: {
    total: number;
    resolved: number;
    unresolved: number;
    blocked: number;
    actionable: number;
  };
  tree: Array<{
    id: string;
    summary: string;
    resolved: boolean;
    children: Array<{
      id: string;
      summary: string;
      resolved: boolean;
      child_count: number;
    }>;
  }>;
  recent_evidence: Array<{
    node_id: string;
    node_summary: string;
    type: string;
    ref: string;
    agent: string;
    timestamp: string;
  }>;
  context_links: string[];
  actionable: Array<{
    id: string;
    summary: string;
    properties: Record<string, unknown>;
  }>;
}

export function handleOnboard(input: OnboardInput): OnboardResult {
  const project = requireString(input?.project, "project");
  const evidenceLimit = optionalNumber(input?.evidence_limit, "evidence_limit", 1, 50) ?? 20;
  const db = getDb();

  // Verify project exists
  const root = getProjectRoot(project);
  if (!root) {
    throw new EngineError("project_not_found", `Project not found: ${project}`);
  }

  // 1. Project summary counts
  const summary = getProjectSummary(project);

  // 2. Tree structure — root's children + their children (depth 1-2)
  const topChildren = db
    .prepare("SELECT * FROM nodes WHERE parent = ? ORDER BY created_at ASC")
    .all(root.id) as NodeRow[];

  const tree = topChildren.map((child) => {
    const grandchildren = db
      .prepare(
        `SELECT id, summary, resolved,
         (SELECT COUNT(*) FROM nodes gc WHERE gc.parent = n.id) as child_count
         FROM nodes n WHERE parent = ? ORDER BY created_at ASC`
      )
      .all(child.id) as Array<{
      id: string;
      summary: string;
      resolved: number;
      child_count: number;
    }>;

    return {
      id: child.id,
      summary: child.summary,
      resolved: child.resolved === 1,
      children: grandchildren.map((gc) => ({
        id: gc.id,
        summary: gc.summary,
        resolved: gc.resolved === 1,
        child_count: gc.child_count,
      })),
    };
  });

  // 3. Recent evidence across all resolved nodes, sorted by timestamp
  const allNodes = db
    .prepare("SELECT id, summary, evidence FROM nodes WHERE project = ? AND resolved = 1 AND evidence != '[]'")
    .all(project) as Array<{ id: string; summary: string; evidence: string }>;

  const allEvidence: OnboardResult["recent_evidence"] = [];
  for (const node of allNodes) {
    const evidence: Evidence[] = JSON.parse(node.evidence);
    for (const ev of evidence) {
      allEvidence.push({
        node_id: node.id,
        node_summary: node.summary,
        type: ev.type,
        ref: ev.ref,
        agent: ev.agent,
        timestamp: ev.timestamp,
      });
    }
  }
  allEvidence.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const recent_evidence = allEvidence.slice(0, evidenceLimit);

  // 4. All context_links aggregated and deduplicated
  const linkRows = db
    .prepare("SELECT context_links FROM nodes WHERE project = ? AND context_links != '[]'")
    .all(project) as Array<{ context_links: string }>;

  const linkSet = new Set<string>();
  for (const row of linkRows) {
    const links: string[] = JSON.parse(row.context_links);
    for (const link of links) {
      linkSet.add(link);
    }
  }
  const context_links = [...linkSet].sort();

  // 5. Actionable tasks preview (like graph_next without claiming)
  const actionableRows = db
    .prepare(
      `SELECT n.id, n.summary, n.properties FROM nodes n
       WHERE n.project = ? AND n.resolved = 0
       AND NOT EXISTS (
         SELECT 1 FROM nodes child WHERE child.parent = n.id AND child.resolved = 0
       )
       AND NOT EXISTS (
         SELECT 1 FROM edges e
         JOIN nodes dep ON dep.id = e.to_node AND dep.resolved = 0
         WHERE e.from_node = n.id AND e.type = 'depends_on'
       )
       ORDER BY
         COALESCE(CAST(json_extract(n.properties, '$.priority') AS REAL), 0) DESC,
         n.depth DESC,
         n.updated_at ASC
       LIMIT 10`
    )
    .all(project) as Array<{ id: string; summary: string; properties: string }>;

  const actionable = actionableRows.map((row) => ({
    id: row.id,
    summary: row.summary,
    properties: JSON.parse(row.properties),
  }));

  return {
    project,
    summary,
    tree,
    recent_evidence,
    context_links,
    actionable,
  };
}
