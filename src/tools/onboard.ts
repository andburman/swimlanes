import { getDb } from "../db.js";
import { getProjectRoot, getProjectSummary, listProjects } from "../nodes.js";
import { optionalString, optionalNumber } from "../validate.js";
import { EngineError } from "../validate.js";
import { computeContinuityConfidence, type ContinuityConfidence } from "../continuity.js";
import { computeIntegrity } from "../integrity.js";
import { getUpdateWarning } from "../server.js";
import type { NodeRow, Evidence } from "../types.js";

// [sl:yosc4NuV6j43Zv0fsDXDj] graph_onboard — single-call orientation for new agents

export interface OnboardInput {
  project?: string;
  evidence_limit?: number;
  strict?: boolean;
}

export interface ChecklistItem {
  check: string;
  status: "pass" | "warn" | "action_required";
  message: string;
  action?: string; // [sl:U9NWRB-786Bm52yOAx8Wd] Prescriptive next step
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
    child_count: number;
    resolved_children: number;
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
  integrity: {
    score: number;
    issue_count: number;
    quality_kpi: { high_quality: number; resolved: number; percentage: number };
  };
  actionable: Array<{
    id: string;
    summary: string;
    priority: number | null;
  }>;
  // [sl:Mox85EgzSfvuXq-JhMFwW] Recommended next task with rationale
  recommended_next?: {
    id: string;
    summary: string;
    rationale: string;
  };
  // [sl:KCXJHZdDEnQfK9sOfrYhW] Blocked and claimed node lists
  blocked_nodes: Array<{
    id: string;
    summary: string;
    reason: string | null;
    age_hours: number;
  }>;
  claimed_nodes: Array<{
    id: string;
    summary: string;
    claimed_by: string;
    age_hours: number;
  }>;
  checklist: Array<{ check: string; status: string; message: string }>;
}

function computeChecklist(
  summary: OnboardResult["summary"],
  recent_evidence: OnboardResult["recent_evidence"],
  knowledge: OnboardResult["knowledge"],
  actionable: OnboardResult["actionable"],
  blocked_nodes: OnboardResult["blocked_nodes"],
  claimed_nodes: OnboardResult["claimed_nodes"],
  db: ReturnType<typeof getDb>,
  project: string,
): ChecklistItem[] {
  const checklist: ChecklistItem[] = [];

  // 1. review_evidence — check evidence coverage on resolved tasks
  if (summary.resolved === 0) {
    checklist.push({ check: "review_evidence", status: "pass", message: "No resolved tasks yet — nothing to review." });
  } else if (recent_evidence.length > 0) {
    checklist.push({ check: "review_evidence", status: "pass", message: "Recent evidence exists — review for context." });
  } else {
    const resolvedWithEvidence = (db.prepare(
      "SELECT COUNT(*) as cnt FROM nodes WHERE project = ? AND parent IS NOT NULL AND resolved = 1 AND evidence != '[]'"
    ).get(project) as { cnt: number }).cnt;
    if (resolvedWithEvidence === 0 && summary.resolved < 5) {
      checklist.push({ check: "review_evidence", status: "warn", message: `${summary.resolved} resolved task(s) have no evidence.`,
        action: `Add evidence to resolved tasks via graph_update with add_evidence.` });
    } else if (resolvedWithEvidence === 0) {
      checklist.push({ check: "review_evidence", status: "action_required", message: `${summary.resolved} resolved task(s) exist but none have evidence — context may be lost.`,
        action: `Run graph_query({ project: "${project}", filter: { resolved: true } }) to find them, then add evidence via graph_update.` });
    } else {
      checklist.push({ check: "review_evidence", status: "pass", message: "Evidence exists on resolved tasks." });
    }
  }

  // 2. review_knowledge — check knowledge entries
  if (knowledge.length > 0) {
    checklist.push({ check: "review_knowledge", status: "pass", message: `${knowledge.length} knowledge entry(s) available.` });
  } else if (summary.resolved >= 5) {
    checklist.push({ check: "review_knowledge", status: "warn", message: "Mature project (5+ resolved tasks) with no knowledge entries.",
      action: `Write key findings via graph_knowledge_write({ project: "${project}", key: "<topic>", content: "..." }).` });
  } else {
    checklist.push({ check: "review_knowledge", status: "pass", message: "No knowledge entries yet — expected for early projects." });
  }

  // 3. confirm_blockers — check for blocked items
  if (summary.blocked === 0) {
    checklist.push({ check: "confirm_blockers", status: "pass", message: "No blocked items." });
  } else {
    const blockerIds = blocked_nodes.slice(0, 3).map(b => b.id).join(", ");
    checklist.push({ check: "confirm_blockers", status: "action_required",
      message: `${summary.blocked} blocked item(s) — confirm blockers are still valid before proceeding.`,
      action: `Review blocked nodes (${blockerIds}) — unblock via graph_update with blocked: false, or confirm still valid.` });
  }

  // 4. check_stale — unresolved tasks not updated in 7+ days
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const staleCount = (db.prepare(
    "SELECT COUNT(*) as cnt FROM nodes WHERE project = ? AND parent IS NOT NULL AND resolved = 0 AND updated_at < ?"
  ).get(project, sevenDaysAgo) as { cnt: number }).cnt;
  if (staleCount === 0) {
    checklist.push({ check: "check_stale", status: "pass", message: "No stale unresolved tasks." });
  } else {
    checklist.push({ check: "check_stale", status: "warn", message: `${staleCount} unresolved task(s) not updated in 7+ days.`,
      action: `Run graph_query({ project: "${project}", filter: { resolved: false }, sort: "recent" }) to find stale tasks. Drop or update them.` });
  }

  // 5. resolve_claimed — detect claimed-but-unresolved nodes (forgotten resolutions)
  if (claimed_nodes.length === 0) {
    checklist.push({ check: "resolve_claimed", status: "pass", message: "No claimed unresolved tasks." });
  } else {
    const claimedIds = claimed_nodes.slice(0, 3).map(c => c.id).join(", ");
    checklist.push({ check: "resolve_claimed", status: "action_required",
      message: `${claimed_nodes.length} claimed task(s) still unresolved — resolve or unclaim before starting new work.`,
      action: `Resolve claimed nodes (${claimedIds}) via graph_resolve, or unclaim via graph_update with properties: { _claimed_by: null, _claimed_at: null }.` });
  }

  // 6. check_pending_verification — [sl:QKuJkdiYUncO6_YVhbJ73] nodes flagged for human verification
  const verificationCount = (db.prepare(
    `SELECT COUNT(*) as cnt FROM nodes
     WHERE project = ? AND resolved = 0
     AND json_extract(properties, '$._needs_verification') IS NOT NULL
     AND json_extract(properties, '$._needs_verification') != 'false'`
  ).get(project) as { cnt: number }).cnt;
  if (verificationCount === 0) {
    checklist.push({ check: "check_pending_verification", status: "pass", message: "No tasks pending human verification." });
  } else {
    checklist.push({ check: "check_pending_verification", status: "action_required",
      message: `${verificationCount} task(s) flagged for human verification — review before resolving.`,
      action: `Run graph_query({ project: "${project}", filter: { properties: { _needs_verification: true } } }) to find them. After verifying, clear the flag via graph_update with properties: { _needs_verification: null }.` });
  }

  // 7. check_missing_context_links — [sl:n4hDdI5Ir37Xf93mb1bE-] resolved leaves with no context_links
  const missingLinksCount = (db.prepare(
    `SELECT COUNT(*) as cnt FROM nodes n
     WHERE n.project = ? AND n.resolved = 1
     AND (n.context_links IS NULL OR n.context_links = '[]')
     AND NOT EXISTS (SELECT 1 FROM nodes c WHERE c.parent = n.id)`
  ).get(project) as { cnt: number }).cnt;
  if (missingLinksCount === 0) {
    checklist.push({ check: "check_missing_context_links", status: "pass", message: "All resolved leaves have context links." });
  } else {
    checklist.push({ check: "check_missing_context_links", status: "warn",
      message: `${missingLinksCount} resolved leaf(s) have no context_links — file traceability is incomplete.` });
  }

  // 8. plan_next_actions — check actionable tasks exist
  if (actionable.length > 0) {
    checklist.push({ check: "plan_next_actions", status: "pass", message: `${actionable.length} actionable task(s) ready.` });
  } else if (summary.unresolved > 0) {
    checklist.push({ check: "plan_next_actions", status: "warn", message: "No actionable tasks — all remaining work is blocked.",
      action: `Check dependencies via graph_query({ project: "${project}", filter: { is_blocked: true } }) and unblock or restructure.` });
  } else if (summary.total <= 1) {
    checklist.push({ check: "plan_next_actions", status: "pass", message: "Empty project — use graph_plan to add tasks." });
  } else {
    checklist.push({ check: "plan_next_actions", status: "pass", message: "All tasks resolved." });
  }

  return checklist;
}

// [sl:1pRRsWFomcv04XAkdLMAj] Allow graph_onboard without project name
export function handleOnboard(input: OnboardInput): OnboardResult | { projects: ReturnType<typeof listProjects>; hint: string } {
  const evidenceLimit = optionalNumber(input?.evidence_limit, "evidence_limit", 1, 50) ?? 20;
  const strict = input?.strict === true;
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

  // Verify project exists — include available projects in error for agent self-correction
  const root = getProjectRoot(project);
  if (!root) {
    const available = listProjects();
    const names = available.map((p) => p.project);
    const suffix = names.length > 0
      ? ` Available projects: ${names.join(", ")}`
      : " No projects exist yet.";
    throw new EngineError("project_not_found", `Project not found: ${project}.${suffix}`);
  }

  // 1. Project summary counts
  const summary = getProjectSummary(project);

  // 2. Tree structure — root's direct children only (depth 1), with child counts
  const topChildren = db
    .prepare(
      `SELECT n.id, n.summary, n.resolved, n.blocked, n.blocked_reason, n.discovery,
       (SELECT COUNT(*) FROM nodes c WHERE c.parent = n.id) as child_count,
       (SELECT COUNT(*) FROM nodes c WHERE c.parent = n.id AND c.resolved = 1) as resolved_children
       FROM nodes n WHERE n.parent = ? ORDER BY n.created_at ASC`
    )
    .all(root.id) as Array<{
    id: string;
    summary: string;
    resolved: number;
    blocked: number;
    blocked_reason: string | null;
    discovery: string | null;
    child_count: number;
    resolved_children: number;
  }>;

  const tree = topChildren.map((child) => ({
    id: child.id,
    summary: child.summary,
    resolved: child.resolved === 1,
    blocked: child.blocked === 1,
    child_count: child.child_count,
    resolved_children: child.resolved_children,
  }));

  // 3. Recent evidence — last 10 entries, ref truncated to 120 chars
  const effectiveLimit = Math.min(evidenceLimit, 10);
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
        ref: ev.ref.length > 120 ? ev.ref.slice(0, 120) + "..." : ev.ref,
        agent: ev.agent,
        timestamp: ev.timestamp,
      });
    }
  }
  allEvidence.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const recent_evidence = allEvidence.slice(0, effectiveLimit);

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
  const context_links = [...linkSet].sort().slice(0, 30);

  // 5. Knowledge entries — keys only (use graph_knowledge_read for content)
  const knowledgeRows = db
    .prepare("SELECT key, updated_at FROM knowledge WHERE project = ? ORDER BY updated_at DESC")
    .all(project) as Array<{ key: string; updated_at: string }>;

  // 6. Actionable tasks preview (like graph_next without claiming)
  const actionableRows = db
    .prepare(
      `SELECT n.id, n.summary, n.properties FROM nodes n
       WHERE n.project = ? AND n.parent IS NOT NULL AND n.resolved = 0 AND n.blocked = 0
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

  const actionable = actionableRows.map((row) => {
    const props = JSON.parse(row.properties);
    return {
      id: row.id,
      summary: row.summary,
      priority: props.priority ?? null,
    };
  });

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

  // [sl:KCXJHZdDEnQfK9sOfrYhW] Blocked nodes with reasons and age
  const blockedRows = db
    .prepare(
      `SELECT id, summary, blocked_reason, updated_at
       FROM nodes
       WHERE project = ? AND parent IS NOT NULL AND resolved = 0 AND blocked = 1
       ORDER BY updated_at ASC
       LIMIT 5`
    )
    .all(project) as Array<{ id: string; summary: string; blocked_reason: string | null; updated_at: string }>;

  const now = Date.now();
  const blocked_nodes = blockedRows.map((r) => ({
    id: r.id,
    summary: r.summary,
    reason: r.blocked_reason,
    age_hours: Math.floor((now - new Date(r.updated_at).getTime()) / (60 * 60 * 1000)),
  }));

  // [sl:KCXJHZdDEnQfK9sOfrYhW] Claimed unresolved nodes with owner and age
  const claimedRows = db
    .prepare(
      `SELECT id, summary,
              json_extract(properties, '$._claimed_by') as claimed_by,
              json_extract(properties, '$._claimed_at') as claimed_at
       FROM nodes
       WHERE project = ? AND parent IS NOT NULL AND resolved = 0
       AND json_extract(properties, '$._claimed_by') IS NOT NULL
       ORDER BY json_extract(properties, '$._claimed_at') ASC
       LIMIT 5`
    )
    .all(project) as Array<{ id: string; summary: string; claimed_by: string; claimed_at: string }>;

  const claimed_nodes = claimedRows.map((r) => ({
    id: r.id,
    summary: r.summary,
    claimed_by: r.claimed_by,
    age_hours: Math.floor((now - new Date(r.claimed_at).getTime()) / (60 * 60 * 1000)),
  }));

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

  // 10. Integrity audit — summary only (use graph_status for full issues)
  const fullIntegrity = computeIntegrity(project);
  const integrity = {
    score: fullIntegrity.score,
    issue_count: fullIntegrity.issues.length,
    quality_kpi: fullIntegrity.quality_kpi,
  };

  // 11. Rehydrate checklist — strip action strings to save tokens (agents use graph_status for details)
  const fullChecklist = computeChecklist(summary, recent_evidence, knowledgeRows, actionable, blocked_nodes, claimed_nodes, db, project);
  const checklist = fullChecklist.map(({ check, status, message }) => ({ check, status, message }));

  // Strict mode: prepend hint warning when action items exist
  if (strict && checklist.some((c) => c.status === "action_required")) {
    const prefix = "\u26A0 Rehydrate checklist has action items \u2014 review before claiming work.";
    hint = hint ? `${prefix}\n${hint}` : prefix;
  }

  // Surface update warning from version check
  const updateHint = getUpdateWarning();
  if (updateHint) {
    hint = hint ? `${hint}\n${updateHint}` : updateHint;
  }

  // [sl:Mox85EgzSfvuXq-JhMFwW] Recommended next task with rationale
  let recommended_next: OnboardResult["recommended_next"];
  if (actionable.length > 0) {
    const top = actionable[0];
    const parts: string[] = [];
    if (top.priority) parts.push(`priority ${top.priority}`);
    if (claimed_nodes.length > 0) parts.push(`${claimed_nodes.length} stale claim(s)`);
    parts.push("top-ranked");
    recommended_next = {
      id: top.id,
      summary: top.summary,
      rationale: parts.join(", "),
    };
  }

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
    integrity,
    actionable,
    recommended_next,
    blocked_nodes,
    claimed_nodes,
    checklist,
  };
}
