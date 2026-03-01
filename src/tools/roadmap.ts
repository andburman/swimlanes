import { getDb } from "../db.js";
import { getProjectRoot, listProjects } from "../nodes.js";
import { optionalString } from "../validate.js";
import { EngineError } from "../validate.js";

// [sl:XOOwcw6PkOaJc-yQOkt2A] graph_roadmap — compact release-pipeline view for PMs

export interface RoadmapInput {
  project?: string;
  detail?: "brief" | "full";
}

interface ReleaseInfo {
  id: string;
  summary: string;
  horizon?: string;
  version?: string;
  resolved: boolean;
  total: number;
  done: number;
  at_risk: boolean;
  at_risk_reasons: string[];
  last_decision?: string;
  last_decision_at?: string;
}

export interface RoadmapResult {
  project: string;
  conventions: { horizon: boolean; version: boolean; fallback?: string };
  horizons?: Record<string, ReleaseInfo[]>;
  releases?: ReleaseInfo[]; // fallback when no horizons
  summary: { total_releases: number; completed: number; at_risk: number };
}

export function handleRoadmap(input: RoadmapInput): RoadmapResult {
  const db = getDb();

  let project = optionalString(input?.project, "project");
  if (!project) {
    const projects = listProjects();
    if (projects.length === 1) {
      project = projects[0].project;
    } else if (projects.length === 0) {
      throw new EngineError("project_not_found", "No projects exist yet.");
    } else {
      throw new EngineError("project_required", `Multiple projects exist (${projects.map(p => p.project).join(", ")}). Specify one.`);
    }
  }

  const root = getProjectRoot(project);
  if (!root) {
    throw new EngineError("project_not_found", `Project not found: ${project}`);
  }

  const detail = (input?.detail === "full") ? "full" : "brief";

  // Get depth-1 children of root — these are the "releases" or top-level groupings
  const releaseRows = db.prepare(
    `SELECT n.id, n.summary, n.resolved, n.properties,
       (SELECT COUNT(*) FROM nodes c WHERE c.parent = n.id) as child_count,
       (SELECT COUNT(*) FROM nodes c WHERE c.parent = n.id AND c.resolved = 1) as resolved_children
     FROM nodes n
     WHERE n.parent = ? AND n.project = ?
     ORDER BY
       COALESCE(CAST(json_extract(n.properties, '$.priority') AS REAL), 0) DESC,
       n.created_at ASC`
  ).all(root.id, project) as Array<{
    id: string;
    summary: string;
    resolved: number;
    properties: string;
    child_count: number;
    resolved_children: number;
  }>;

  // Detect conventions
  let hasHorizon = false;
  let hasVersion = false;

  const releases: ReleaseInfo[] = [];

  for (const row of releaseRows) {
    const props = JSON.parse(row.properties);
    if (props.horizon) hasHorizon = true;
    if (props.version) hasVersion = true;

    // Count total descendants (not just direct children) for accurate progress
    const descCount = db.prepare(
      `WITH RECURSIVE descendants(id) AS (
        SELECT id FROM nodes WHERE parent = ?
        UNION ALL
        SELECT n.id FROM nodes n JOIN descendants d ON n.parent = d.id
      )
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN n.resolved = 1 THEN 1 ELSE 0 END) as done
      FROM descendants d
      JOIN nodes n ON n.id = d.id`
    ).get(row.id) as { total: number; done: number };

    // at_risk detection
    const atRiskReasons: string[] = [];

    // Primary: PM-flagged
    if (props.at_risk === true) {
      atRiskReasons.push("flagged by PM");
    }

    // Secondary: inference rules
    if (!row.resolved) {
      // Unresolved blockers among descendants
      const blockedCount = (db.prepare(
        `WITH RECURSIVE descendants(id) AS (
          SELECT id FROM nodes WHERE parent = ?
          UNION ALL
          SELECT n.id FROM nodes n JOIN descendants d ON n.parent = d.id
        )
        SELECT COUNT(*) as cnt FROM descendants d
        JOIN nodes n ON n.id = d.id
        WHERE n.blocked = 1 AND n.resolved = 0`
      ).get(row.id) as { cnt: number }).cnt;
      if (blockedCount > 0) {
        atRiskReasons.push(`${blockedCount} blocked task(s)`);
      }

      // Stale: no updates in 14+ days
      const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
      const freshCount = (db.prepare(
        `WITH RECURSIVE descendants(id) AS (
          SELECT id FROM nodes WHERE parent = ?
          UNION ALL
          SELECT n.id FROM nodes n JOIN descendants d ON n.parent = d.id
        )
        SELECT COUNT(*) as cnt FROM descendants d
        JOIN nodes n ON n.id = d.id
        WHERE n.updated_at > ?`
      ).get(row.id, fourteenDaysAgo) as { cnt: number }).cnt;
      if (descCount.total > 0 && freshCount === 0) {
        atRiskReasons.push("stale (no activity in 14d)");
      }

      // Sibling comparison: 0% progress while any sibling >50%
      if (descCount.total > 0 && descCount.done === 0) {
        const siblingProgress = db.prepare(
          `SELECT n.id,
             (SELECT COUNT(*) FROM nodes c WHERE c.parent = n.id AND c.resolved = 1) as done,
             (SELECT COUNT(*) FROM nodes c WHERE c.parent = n.id) as total
           FROM nodes n
           WHERE n.parent = ? AND n.id != ? AND n.resolved = 0`
        ).all(root.id, row.id) as Array<{ id: string; done: number; total: number }>;
        const anyFarAhead = siblingProgress.some(s => s.total > 0 && (s.done / s.total) > 0.5);
        if (anyFarAhead) {
          atRiskReasons.push("0% while sibling releases >50%");
        }
      }
    }

    // last_decision: most recent decision_context from events under this subtree
    let lastDecision: string | undefined;
    let lastDecisionAt: string | undefined;

    if (detail === "full" || atRiskReasons.length > 0) {
      const decisionRow = db.prepare(
        `WITH RECURSIVE descendants(id) AS (
          SELECT ? as id
          UNION ALL
          SELECT n.id FROM nodes n JOIN descendants d ON n.parent = d.id
        )
        SELECT e.decision_context, e.timestamp FROM events e
        JOIN descendants d ON e.node_id = d.id
        WHERE e.decision_context IS NOT NULL
        ORDER BY e.timestamp DESC
        LIMIT 1`
      ).get(row.id) as { decision_context: string; timestamp: string } | undefined;

      if (decisionRow) {
        lastDecision = decisionRow.decision_context;
        lastDecisionAt = decisionRow.timestamp;
      }
    }

    releases.push({
      id: row.id,
      summary: row.summary,
      horizon: props.horizon,
      version: props.version,
      resolved: row.resolved === 1,
      total: descCount.total,
      done: descCount.done,
      at_risk: atRiskReasons.length > 0,
      at_risk_reasons: atRiskReasons,
      last_decision: lastDecision,
      last_decision_at: lastDecisionAt,
    });
  }

  const conventions = {
    horizon: hasHorizon,
    version: hasVersion,
    ...((!hasHorizon && !hasVersion) ? { fallback: "tree_structure" } : {}),
  };

  const completed = releases.filter(r => r.resolved).length;
  const atRiskCount = releases.filter(r => r.at_risk).length;
  const summaryStats = { total_releases: releases.length, completed, at_risk: atRiskCount };

  // Strip verbose fields in brief mode
  const formatRelease = (r: ReleaseInfo): ReleaseInfo => {
    if (detail === "brief") {
      const brief: ReleaseInfo = {
        id: r.id,
        summary: r.summary,
        resolved: r.resolved,
        total: r.total,
        done: r.done,
        at_risk: r.at_risk,
        at_risk_reasons: r.at_risk_reasons,
      };
      if (r.horizon) brief.horizon = r.horizon;
      if (r.version) brief.version = r.version;
      if (r.last_decision) brief.last_decision = r.last_decision;
      return brief;
    }
    return r;
  };

  // Group by horizon if convention detected
  if (hasHorizon) {
    const horizonOrder = ["now", "next", "later", "paused"];
    const grouped: Record<string, ReleaseInfo[]> = {};

    for (const r of releases) {
      const h = r.horizon ?? "ungrouped";
      if (!grouped[h]) grouped[h] = [];
      grouped[h].push(formatRelease(r));
    }

    // Sort horizons: known order first, then alphabetical for custom ones
    const sortedGrouped: Record<string, ReleaseInfo[]> = {};
    const allKeys = Object.keys(grouped);
    const ordered = allKeys.sort((a, b) => {
      const ai = horizonOrder.indexOf(a);
      const bi = horizonOrder.indexOf(b);
      if (ai !== -1 && bi !== -1) return ai - bi;
      if (ai !== -1) return -1;
      if (bi !== -1) return 1;
      return a.localeCompare(b);
    });
    for (const k of ordered) {
      sortedGrouped[k] = grouped[k];
    }

    return { project, conventions, horizons: sortedGrouped, summary: summaryStats };
  }

  // Fallback: flat release list
  return { project, conventions, releases: releases.map(formatRelease), summary: summaryStats };
}
