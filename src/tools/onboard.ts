import { getDb } from "../db.js";
import { getProjectRoot, getProjectSummary, listProjects } from "../nodes.js";
import { optionalString, optionalNumber } from "../validate.js";
import { EngineError } from "../validate.js";
import { computeContinuityConfidence, type ContinuityConfidence } from "../continuity.js";
import type { NodeRow, Evidence } from "../types.js";

// [sl:yosc4NuV6j43Zv0fsDXDj] graph_onboard — single-call orientation for new agents

export interface OnboardInput {
  project?: string;
  evidence_limit?: number;
}

export interface OnboardResult {
  project: string;
  goal: string;
  discovery: string | null;
  hint?: string;
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
    blocked: boolean;
    blocked_reason: string | null;
    children: Array<{
      id: string;
      summary: string;
      resolved: boolean;
      blocked: boolean;
      blocked_reason: string | null;
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
  knowledge: Array<{
    key: string;
    content: string;
    updated_at: string;
  }>;
  recently_resolved: Array<{
    id: string;
    summary: string;
    resolved_at: string;
    agent: string;
  }>;
  last_activity: string | null;
  continuity_confidence: ContinuityConfidence;
  actionable: Array<{
    id: string;
    summary: string;
    properties: Record<string, unknown>;
  }>;
}

// [sl:1pRRsWFomcv04XAkdLMAj] Allow graph_onboard without project name
export function handleOnboard(input: OnboardInput): OnboardResult | { projects: ReturnType<typeof listProjects>; hint: string } {
  const evidenceLimit = optionalNumber(input?.evidence_limit, "evidence_limit", 1, 50) ?? 20;
  const db = getDb();

  // Auto-resolve project when not specified
  let project = optionalString(input?.project, "project");
  if (!project) {
    const projects = listProjects();
    if (projects.length === 0) {
      return {
        projects: [],
        hint: "No projects yet. Create one with graph_open({ project: \"my-project\", goal: \"...\" }).",
      };
    }
    if (projects.length === 1) {
      project = projects[0].project;
    } else {
      return {
        projects,
        hint: `${projects.length} projects found. Call graph_onboard with a specific project name.`,
      };
    }
  }

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
        `SELECT id, summary, resolved, blocked, blocked_reason,
         (SELECT COUNT(*) FROM nodes gc WHERE gc.parent = n.id) as child_count
         FROM nodes n WHERE parent = ? ORDER BY created_at ASC`
      )
      .all(child.id) as Array<{
      id: string;
      summary: string;
      resolved: number;
      blocked: number;
      blocked_reason: string | null;
      child_count: number;
    }>;

    return {
      id: child.id,
      summary: child.summary,
      resolved: child.resolved === 1,
      discovery: child.discovery,
      blocked: child.blocked === 1,
      blocked_reason: child.blocked_reason,
      children: grandchildren.map((gc) => ({
        id: gc.id,
        summary: gc.summary,
        resolved: gc.resolved === 1,
        blocked: gc.blocked === 1,
        blocked_reason: gc.blocked_reason,
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

  // 5. Knowledge entries
  const knowledgeRows = db
    .prepare("SELECT key, content, updated_at FROM knowledge WHERE project = ? ORDER BY updated_at DESC")
    .all(project) as Array<{ key: string; content: string; updated_at: string }>;

  // 6. Actionable tasks preview (like graph_next without claiming)
  const actionableRows = db
    .prepare(
      `SELECT n.id, n.summary, n.properties FROM nodes n
       WHERE n.project = ? AND n.resolved = 0 AND n.blocked = 0
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

  // 7. Recently resolved nodes (last 24h) — cross-session continuity
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const recentlyResolvedRows = db
    .prepare(
      `SELECT id, summary, updated_at,
       (SELECT json_extract(value, '$.agent') FROM json_each(evidence) ORDER BY json_extract(value, '$.timestamp') DESC LIMIT 1) as last_agent
       FROM nodes
       WHERE project = ? AND resolved = 1 AND updated_at > ?
       ORDER BY updated_at DESC
       LIMIT 10`
    )
    .all(project, oneDayAgo) as Array<{ id: string; summary: string; updated_at: string; last_agent: string | null }>;

  const recently_resolved = recentlyResolvedRows.map((row) => ({
    id: row.id,
    summary: row.summary,
    resolved_at: row.updated_at,
    agent: row.last_agent ?? "unknown",
  }));

  // 8. Last activity timestamp
  const lastActivityRow = db
    .prepare("SELECT MAX(updated_at) as last FROM nodes WHERE project = ?")
    .get(project) as { last: string | null };
  const last_activity = lastActivityRow.last;

  // Build hint based on project state
  let hint: string | undefined;
  if (root.discovery === "pending") {
    hint = `Discovery is pending. Interview the user to understand scope and goals, write knowledge entries with findings, then set discovery to "done" via graph_update before decomposing with graph_plan.`;
  } else if (actionable.length > 0) {
    const recentNote = recently_resolved.length > 0
      ? ` ${recently_resolved.length} task(s) resolved recently.`
      : "";
    hint = `${actionable.length} actionable task(s) ready.${recentNote} Use graph_next({ project: "${project}", claim: true }) to claim one.`;
  } else if (summary.unresolved > 0 && summary.actionable === 0) {
    hint = `All remaining tasks are blocked. Check dependencies with graph_query.`;
  } else if (summary.total <= 1 && root.discovery !== "pending") {
    hint = `Project is empty — use graph_plan to decompose the goal into tasks.`;
  }

  // 9. Continuity confidence signal
  const continuity_confidence = computeContinuityConfidence(project);

  return {
    project,
    goal: root.summary,
    discovery: root.discovery,
    hint,
    summary,
    tree,
    recent_evidence,
    context_links,
    knowledge: knowledgeRows,
    recently_resolved,
    last_activity,
    continuity_confidence,
    actionable,
  };
}
