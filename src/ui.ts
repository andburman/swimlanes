// [sl:as5ASDpS7g5tuIdTBXBGM] Scaffold UI server — HTTP server for Graph dashboard
// [sl:V8RhUfBxqje0-29NKMJxV] Internal JSON endpoints — read-only API for dashboard

import { createServer, type ServerResponse } from "node:http";
import { exec } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";
import Database from "better-sqlite3";

type Db = Database.Database;

// --- JSON helpers ---

function json(res: ServerResponse, data: unknown): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function notFound(res: ServerResponse): void {
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
}

function parseJsonField(val: string): unknown {
  try { return JSON.parse(val); } catch { return val; }
}

// --- API handlers ---

function apiProjects(db: Db, res: ServerResponse): void {
  const roots = db.prepare(
    "SELECT id, project, summary, updated_at FROM nodes WHERE parent IS NULL ORDER BY updated_at DESC"
  ).all() as Array<{ id: string; project: string; summary: string; updated_at: string }>;

  const projects = roots.map((root) => {
    const counts = db.prepare(
      `SELECT COUNT(*) as total,
              SUM(CASE WHEN resolved = 1 THEN 1 ELSE 0 END) as resolved
       FROM nodes WHERE project = ?`
    ).get(root.project) as { total: number; resolved: number };

    const blocked = (db.prepare(
      `SELECT COUNT(DISTINCT id) as cnt FROM (
         SELECT n.id FROM nodes n WHERE n.project = ? AND n.resolved = 0 AND n.blocked = 1
         UNION
         SELECT n.id FROM nodes n
         JOIN edges e ON e.from_node = n.id AND e.type = 'depends_on'
         JOIN nodes dep ON dep.id = e.to_node AND dep.resolved = 0
         WHERE n.project = ? AND n.resolved = 0
       )`
    ).get(root.project, root.project) as { cnt: number }).cnt;

    const actionable = (db.prepare(
      `SELECT COUNT(*) as cnt FROM nodes n
       WHERE n.project = ? AND n.resolved = 0 AND n.blocked = 0
       AND NOT EXISTS (SELECT 1 FROM nodes c WHERE c.parent = n.id AND c.resolved = 0)
       AND NOT EXISTS (
         SELECT 1 FROM edges e JOIN nodes dep ON dep.id = e.to_node AND dep.resolved = 0
         WHERE e.from_node = n.id AND e.type = 'depends_on'
       )`
    ).get(root.project) as { cnt: number }).cnt;

    return {
      project: root.project,
      id: root.id,
      summary: root.summary,
      total: counts.total,
      resolved: counts.resolved,
      unresolved: counts.total - counts.resolved,
      blocked,
      actionable,
      updated_at: root.updated_at,
    };
  });

  json(res, projects);
}

function apiProjectTree(db: Db, project: string, res: ServerResponse): void {
  const root = db.prepare(
    "SELECT id FROM nodes WHERE project = ? AND parent IS NULL"
  ).get(project) as { id: string } | undefined;

  if (!root) { notFound(res); return; }

  const rows = db.prepare(
    `SELECT id, parent, summary, resolved, depth, discovery, blocked, blocked_reason,
            properties, context_links, evidence, created_at, updated_at
     FROM nodes WHERE project = ? ORDER BY depth ASC, created_at ASC`
  ).all(project) as Array<{
    id: string; parent: string | null; summary: string; resolved: number;
    depth: number; discovery: string | null; blocked: number; blocked_reason: string | null;
    properties: string; context_links: string; evidence: string;
    created_at: string; updated_at: string;
  }>;

  const nodes = rows.map((r) => ({
    id: r.id,
    parent: r.parent,
    summary: r.summary,
    resolved: r.resolved === 1,
    depth: r.depth,
    discovery: r.discovery,
    blocked: r.blocked === 1,
    blocked_reason: r.blocked_reason,
    properties: parseJsonField(r.properties),
    context_links: parseJsonField(r.context_links),
    evidence: parseJsonField(r.evidence),
    created_at: r.created_at,
    updated_at: r.updated_at,
  }));

  const edges = db.prepare(
    `SELECT e.from_node, e.to_node, e.type
     FROM edges e
     WHERE e.from_node IN (SELECT id FROM nodes WHERE project = ?)`
  ).all(project) as Array<{ from_node: string; to_node: string; type: string }>;

  const counts = db.prepare(
    `SELECT COUNT(*) as total,
            SUM(CASE WHEN resolved = 1 THEN 1 ELSE 0 END) as resolved
     FROM nodes WHERE project = ?`
  ).get(project) as { total: number; resolved: number };

  json(res, {
    project,
    root_id: root.id,
    nodes,
    edges,
    stats: { total: counts.total, resolved: counts.resolved, unresolved: counts.total - counts.resolved },
  });
}

function apiTree(db: Db, res: ServerResponse): void {
  const rows = db.prepare(
    `SELECT id, parent, project, summary, resolved, depth, discovery, blocked, blocked_reason,
            properties, context_links, evidence, created_at, updated_at
     FROM nodes ORDER BY depth ASC, created_at ASC`
  ).all() as Array<{
    id: string; parent: string | null; project: string; summary: string; resolved: number;
    depth: number; discovery: string | null; blocked: number; blocked_reason: string | null;
    properties: string; context_links: string; evidence: string;
    created_at: string; updated_at: string;
  }>;

  const now = new Date().toISOString();
  const nodes: unknown[] = [{
    id: '__root__', parent: null, summary: 'Graph', resolved: false, depth: -1,
    discovery: null, blocked: false, blocked_reason: null,
    properties: {}, context_links: [], evidence: [],
    created_at: now, updated_at: now,
  }];

  for (const r of rows) {
    nodes.push({
      id: r.id,
      parent: r.parent === null ? '__root__' : r.parent,
      summary: r.summary,
      resolved: r.resolved === 1,
      depth: r.depth,
      discovery: r.discovery,
      blocked: r.blocked === 1,
      blocked_reason: r.blocked_reason,
      properties: parseJsonField(r.properties),
      context_links: parseJsonField(r.context_links),
      evidence: parseJsonField(r.evidence),
      created_at: r.created_at,
      updated_at: r.updated_at,
      _project: r.project,
    });
  }

  const edges = db.prepare(
    "SELECT from_node, to_node, type FROM edges"
  ).all() as Array<{ from_node: string; to_node: string; type: string }>;

  const total = rows.length;
  const resolved = rows.filter(r => r.resolved === 1).length;

  const blocked = (db.prepare(
    `SELECT COUNT(DISTINCT id) as cnt FROM (
       SELECT n.id FROM nodes n WHERE n.resolved = 0 AND n.blocked = 1
       UNION
       SELECT n.id FROM nodes n
       JOIN edges e ON e.from_node = n.id AND e.type = 'depends_on'
       JOIN nodes dep ON dep.id = e.to_node AND dep.resolved = 0
       WHERE n.resolved = 0
     )`
  ).get() as { cnt: number }).cnt;

  const actionable = (db.prepare(
    `SELECT COUNT(*) as cnt FROM nodes n
     WHERE n.resolved = 0 AND n.blocked = 0
     AND NOT EXISTS (SELECT 1 FROM nodes c WHERE c.parent = n.id AND c.resolved = 0)
     AND NOT EXISTS (
       SELECT 1 FROM edges e JOIN nodes dep ON dep.id = e.to_node AND dep.resolved = 0
       WHERE e.from_node = n.id AND e.type = 'depends_on'
     )`
  ).get() as { cnt: number }).cnt;

  json(res, {
    root_id: '__root__',
    nodes,
    edges,
    stats: { total, resolved, unresolved: total - resolved, blocked, actionable },
  });
}

function apiProjectKnowledge(db: Db, project: string, res: ServerResponse): void {
  const rows = db.prepare(
    "SELECT key, content, created_by, created_at, updated_at FROM knowledge WHERE project = ? ORDER BY updated_at DESC"
  ).all(project) as Array<{ key: string; content: string; created_by: string; created_at: string; updated_at: string }>;

  json(res, rows);
}

function apiProjectOnboard(db: Db, project: string, res: ServerResponse): void {
  const root = db.prepare(
    "SELECT id, summary, discovery, updated_at FROM nodes WHERE project = ? AND parent IS NULL"
  ).get(project) as { id: string; summary: string; discovery: string | null; updated_at: string } | undefined;

  if (!root) { notFound(res); return; }

  // Summary stats
  const counts = db.prepare(
    `SELECT COUNT(*) as total,
            SUM(CASE WHEN resolved = 1 THEN 1 ELSE 0 END) as resolved
     FROM nodes WHERE project = ?`
  ).get(project) as { total: number; resolved: number };

  const blocked = (db.prepare(
    `SELECT COUNT(DISTINCT id) as cnt FROM (
       SELECT n.id FROM nodes n WHERE n.project = ? AND n.resolved = 0 AND n.blocked = 1
       UNION
       SELECT n.id FROM nodes n
       JOIN edges e ON e.from_node = n.id AND e.type = 'depends_on'
       JOIN nodes dep ON dep.id = e.to_node AND dep.resolved = 0
       WHERE n.project = ? AND n.resolved = 0
     )`
  ).get(project, project) as { cnt: number }).cnt;

  const actionableCount = (db.prepare(
    `SELECT COUNT(*) as cnt FROM nodes n
     WHERE n.project = ? AND n.resolved = 0 AND n.blocked = 0
     AND NOT EXISTS (SELECT 1 FROM nodes c WHERE c.parent = n.id AND c.resolved = 0)
     AND NOT EXISTS (
       SELECT 1 FROM edges e JOIN nodes dep ON dep.id = e.to_node AND dep.resolved = 0
       WHERE e.from_node = n.id AND e.type = 'depends_on'
     )`
  ).get(project) as { cnt: number }).cnt;

  // Recent evidence (last 20)
  const evidenceNodes = db.prepare(
    "SELECT id, summary, evidence FROM nodes WHERE project = ? AND resolved = 1 AND evidence != '[]'"
  ).all(project) as Array<{ id: string; summary: string; evidence: string }>;

  const allEvidence: Array<{ node_id: string; node_summary: string; type: string; ref: string; agent: string; timestamp: string }> = [];
  for (const n of evidenceNodes) {
    const evs = JSON.parse(n.evidence) as Array<{ type: string; ref: string; agent: string; timestamp: string }>;
    for (const ev of evs) {
      allEvidence.push({ node_id: n.id, node_summary: n.summary, ...ev });
    }
  }
  allEvidence.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  // Recently resolved (last 24h)
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const recentlyResolved = db.prepare(
    `SELECT id, summary, updated_at FROM nodes
     WHERE project = ? AND resolved = 1 AND updated_at > ?
     ORDER BY updated_at DESC LIMIT 10`
  ).all(project, oneDayAgo) as Array<{ id: string; summary: string; updated_at: string }>;

  // Actionable tasks
  const actionableRows = db.prepare(
    `SELECT n.id, n.summary, n.properties FROM nodes n
     WHERE n.project = ? AND n.resolved = 0 AND n.blocked = 0
     AND NOT EXISTS (SELECT 1 FROM nodes c WHERE c.parent = n.id AND c.resolved = 0)
     AND NOT EXISTS (
       SELECT 1 FROM edges e JOIN nodes dep ON dep.id = e.to_node AND dep.resolved = 0
       WHERE e.from_node = n.id AND e.type = 'depends_on'
     )
     ORDER BY COALESCE(CAST(json_extract(n.properties, '$.priority') AS REAL), 0) DESC,
              n.depth DESC, n.updated_at ASC
     LIMIT 10`
  ).all(project) as Array<{ id: string; summary: string; properties: string }>;

  // Last activity
  const lastActivity = (db.prepare(
    "SELECT MAX(updated_at) as last FROM nodes WHERE project = ?"
  ).get(project) as { last: string | null }).last;

  // [sl:qWH2XXNd5544CkuiC_X3i] Continuity confidence (mirrors continuity.ts logic)
  const totalNonRoot = counts.total - 1;
  const resolvedNonRoot = counts.resolved - (root.updated_at ? 0 : 0); // root resolve status doesn't matter here
  const resolvedCount = (db.prepare(
    "SELECT COUNT(*) as cnt FROM nodes WHERE project = ? AND parent IS NOT NULL AND resolved = 1"
  ).get(project) as { cnt: number }).cnt;
  const resolvedWithEvidence = (db.prepare(
    "SELECT COUNT(*) as cnt FROM nodes WHERE project = ? AND parent IS NOT NULL AND resolved = 1 AND evidence != '[]'"
  ).get(project) as { cnt: number }).cnt;
  const knowledgeCount = (db.prepare(
    "SELECT COUNT(*) as cnt FROM knowledge WHERE project = ?"
  ).get(project) as { cnt: number }).cnt;
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const staleBlockedCount = (db.prepare(
    "SELECT COUNT(*) as cnt FROM nodes WHERE project = ? AND parent IS NOT NULL AND resolved = 0 AND blocked = 1 AND updated_at < ?"
  ).get(project, sevenDaysAgo) as { cnt: number }).cnt;

  let score = 100;
  const reasons: string[] = [];
  if (totalNonRoot === 0) {
    score -= 10;
    reasons.push("Empty project");
  } else {
    const coverage = resolvedCount > 0 ? resolvedWithEvidence / resolvedCount : 1;
    if (coverage < 0.5) { score -= 40; reasons.push("Low evidence coverage"); }
    else if (coverage < 0.8) { score -= 20; reasons.push("Moderate evidence coverage"); }
    else if (coverage < 1) { score -= 10; }
  }
  if (lastActivity) {
    const daysSince = (Date.now() - new Date(lastActivity).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSince >= 14) { score -= 25; reasons.push("No activity for 14+ days"); }
    else if (daysSince >= 7) { score -= 15; reasons.push("No activity for 7+ days"); }
    else if (daysSince >= 3) { score -= 5; }
  }
  if (resolvedCount >= 5 && knowledgeCount === 0) {
    score -= 15; reasons.push("No knowledge entries");
  }
  if (staleBlockedCount > 0) { score -= 10; reasons.push("Stale blockers"); }
  if (score < 0) score = 0;
  const confidence = score >= 70 ? "high" : score >= 40 ? "medium" : "low";

  // Checklist summary
  const claimedUnresolved = (db.prepare(
    "SELECT COUNT(*) as cnt FROM nodes WHERE project = ? AND parent IS NOT NULL AND resolved = 0 AND json_extract(properties, '$._claimed_by') IS NOT NULL"
  ).get(project) as { cnt: number }).cnt;
  const staleUnresolved = (db.prepare(
    "SELECT COUNT(*) as cnt FROM nodes WHERE project = ? AND parent IS NOT NULL AND resolved = 0 AND updated_at < ?"
  ).get(project, sevenDaysAgo) as { cnt: number }).cnt;

  let checkPass = 0, checkWarn = 0, checkAction = 0;
  // evidence coverage
  if (resolvedCount === 0 || resolvedWithEvidence / resolvedCount >= 0.8) checkPass++; else if (resolvedWithEvidence / resolvedCount >= 0.5) checkWarn++; else checkAction++;
  // knowledge
  if (resolvedCount < 5 || knowledgeCount > 0) checkPass++; else checkAction++;
  // blockers
  if (staleBlockedCount === 0) checkPass++; else checkAction++;
  // stale tasks
  if (staleUnresolved === 0) checkPass++; else checkWarn++;
  // claimed unresolved
  if (claimedUnresolved === 0) checkPass++; else checkAction++;
  // actionable
  if (actionableCount > 0) checkPass++; else checkWarn++;

  json(res, {
    project,
    goal: root.summary,
    discovery: root.discovery,
    summary: {
      total: counts.total,
      resolved: counts.resolved,
      unresolved: counts.total - counts.resolved,
      blocked,
      actionable: actionableCount,
    },
    continuity: { score, confidence, reasons },
    checklist: { pass: checkPass, warn: checkWarn, action: checkAction },
    recent_evidence: allEvidence.slice(0, 20),
    recently_resolved: recentlyResolved,
    actionable: actionableRows.map((r) => ({ id: r.id, summary: r.summary, properties: parseJsonField(r.properties) })),
    last_activity: lastActivity,
  });
}

function apiOnboard(db: Db, res: ServerResponse): void {
  const counts = db.prepare(
    `SELECT COUNT(*) as total,
            SUM(CASE WHEN resolved = 1 THEN 1 ELSE 0 END) as resolved
     FROM nodes`
  ).get() as { total: number; resolved: number };

  const blocked = (db.prepare(
    `SELECT COUNT(DISTINCT id) as cnt FROM (
       SELECT n.id FROM nodes n WHERE n.resolved = 0 AND n.blocked = 1
       UNION
       SELECT n.id FROM nodes n
       JOIN edges e ON e.from_node = n.id AND e.type = 'depends_on'
       JOIN nodes dep ON dep.id = e.to_node AND dep.resolved = 0
       WHERE n.resolved = 0
     )`
  ).get() as { cnt: number }).cnt;

  const actionableCount = (db.prepare(
    `SELECT COUNT(*) as cnt FROM nodes n
     WHERE n.resolved = 0 AND n.blocked = 0
     AND NOT EXISTS (SELECT 1 FROM nodes c WHERE c.parent = n.id AND c.resolved = 0)
     AND NOT EXISTS (
       SELECT 1 FROM edges e JOIN nodes dep ON dep.id = e.to_node AND dep.resolved = 0
       WHERE e.from_node = n.id AND e.type = 'depends_on'
     )`
  ).get() as { cnt: number }).cnt;

  const lastActivity = (db.prepare(
    "SELECT MAX(updated_at) as last FROM nodes"
  ).get() as { last: string | null }).last;

  const rootCount = (db.prepare(
    "SELECT COUNT(*) as cnt FROM nodes WHERE parent IS NULL"
  ).get() as { cnt: number }).cnt;
  const totalNonRoot = counts.total - rootCount;
  const resolvedCount = (db.prepare(
    "SELECT COUNT(*) as cnt FROM nodes WHERE parent IS NOT NULL AND resolved = 1"
  ).get() as { cnt: number }).cnt;
  const resolvedWithEvidence = (db.prepare(
    "SELECT COUNT(*) as cnt FROM nodes WHERE parent IS NOT NULL AND resolved = 1 AND evidence != '[]'"
  ).get() as { cnt: number }).cnt;
  const knowledgeCount = (db.prepare(
    "SELECT COUNT(*) as cnt FROM knowledge"
  ).get() as { cnt: number }).cnt;
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const staleBlockedCount = (db.prepare(
    "SELECT COUNT(*) as cnt FROM nodes WHERE parent IS NOT NULL AND resolved = 0 AND blocked = 1 AND updated_at < ?"
  ).get(sevenDaysAgo) as { cnt: number }).cnt;

  let score = 100;
  const reasons: string[] = [];
  if (totalNonRoot === 0) {
    score -= 10;
    reasons.push("Empty project");
  } else {
    const coverage = resolvedCount > 0 ? resolvedWithEvidence / resolvedCount : 1;
    if (coverage < 0.5) { score -= 40; reasons.push("Low evidence coverage"); }
    else if (coverage < 0.8) { score -= 20; reasons.push("Moderate evidence coverage"); }
    else if (coverage < 1) { score -= 10; }
  }
  if (lastActivity) {
    const daysSince = (Date.now() - new Date(lastActivity).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSince >= 14) { score -= 25; reasons.push("No activity for 14+ days"); }
    else if (daysSince >= 7) { score -= 15; reasons.push("No activity for 7+ days"); }
    else if (daysSince >= 3) { score -= 5; }
  }
  if (resolvedCount >= 5 && knowledgeCount === 0) {
    score -= 15; reasons.push("No knowledge entries");
  }
  if (staleBlockedCount > 0) { score -= 10; reasons.push("Stale blockers"); }
  if (score < 0) score = 0;
  const confidence = score >= 70 ? "high" : score >= 40 ? "medium" : "low";

  const claimedUnresolved = (db.prepare(
    "SELECT COUNT(*) as cnt FROM nodes WHERE parent IS NOT NULL AND resolved = 0 AND json_extract(properties, '$._claimed_by') IS NOT NULL"
  ).get() as { cnt: number }).cnt;
  const staleUnresolved = (db.prepare(
    "SELECT COUNT(*) as cnt FROM nodes WHERE parent IS NOT NULL AND resolved = 0 AND updated_at < ?"
  ).get(sevenDaysAgo) as { cnt: number }).cnt;

  let checkPass = 0, checkWarn = 0, checkAction = 0;
  if (resolvedCount === 0 || resolvedWithEvidence / resolvedCount >= 0.8) checkPass++; else if (resolvedWithEvidence / resolvedCount >= 0.5) checkWarn++; else checkAction++;
  if (resolvedCount < 5 || knowledgeCount > 0) checkPass++; else checkAction++;
  if (staleBlockedCount === 0) checkPass++; else checkAction++;
  if (staleUnresolved === 0) checkPass++; else checkWarn++;
  if (claimedUnresolved === 0) checkPass++; else checkAction++;
  if (actionableCount > 0) checkPass++; else checkWarn++;

  json(res, {
    goal: 'Graph',
    summary: {
      total: counts.total,
      resolved: counts.resolved,
      unresolved: counts.total - counts.resolved,
      blocked,
      actionable: actionableCount,
    },
    continuity: { score, confidence, reasons },
    checklist: { pass: checkPass, warn: checkWarn, action: checkAction },
    last_activity: lastActivity,
  });
}

// [sl:po3iXlhOhpAtSgZKtRIuj] Node history endpoint for detail sidebar
function apiNodeHistory(db: Db, nodeId: string, res: ServerResponse): void {
  const node = db.prepare("SELECT id FROM nodes WHERE id = ?").get(nodeId) as { id: string } | undefined;
  if (!node) { notFound(res); return; }

  const events = db.prepare(
    "SELECT id, agent, action, changes, timestamp FROM events WHERE node_id = ? ORDER BY timestamp DESC LIMIT 50"
  ).all(nodeId) as Array<{ id: string; agent: string; action: string; changes: string; timestamp: string }>;

  json(res, events.map((e) => ({
    id: e.id,
    agent: e.agent,
    action: e.action,
    changes: parseJsonField(e.changes),
    timestamp: e.timestamp,
  })));
}

let PKG_VERSION = "0.0.0";
try {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));
  PKG_VERSION = pkg.version;
} catch {}

// [sl:MlvcgOdsi28Lwei5hjTyw] Single HTML file shell — layout, data loading, header stats
const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Graph</title>
  <style>
    :root {
      --bg: #0a0a0f;
      --surface: #13131a;
      --elevated: #1a1a26;
      --border: #1e1e2a;
      --text: #e0e0e8;
      --text-dim: #6a6a80;
      --text-muted: #44445a;
      --accent: #4a9eff;
      --green: #34d399;
      --orange: #f59e0b;
      --red: #ef4444;
      --header-h: 52px;
      --sidebar-w: 360px;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      height: 100vh;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }

    /* Header */
    header {
      height: var(--header-h);
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      padding: 0 16px;
      gap: 14px;
      flex-shrink: 0;
    }
    .logo {
      font-size: 14px;
      font-weight: 600;
      color: var(--accent);
      letter-spacing: 0.5px;
      white-space: nowrap;
    }
    /* Progress */
    .progress-wrap {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .progress-track {
      width: 100px;
      height: 6px;
      background: var(--border);
      border-radius: 3px;
      overflow: hidden;
    }
    .progress-fill {
      height: 100%;
      border-radius: 3px;
      transition: width 0.4s ease, background 0.4s ease;
      width: 0%;
    }
    .progress-label {
      font-size: 11px;
      color: var(--text-dim);
      white-space: nowrap;
    }

    /* Stats */
    .stats {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-left: auto;
    }
    .stat {
      display: flex;
      align-items: center;
      gap: 4px;
      font-size: 12px;
      color: var(--text-dim);
    }
    .stat-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
    }
    .stat-dot.actionable { background: var(--accent); }
    .stat-dot.blocked { background: var(--red); }
    .stat-value { font-weight: 600; color: var(--text); }
    .last-activity {
      font-size: 11px;
      color: var(--text-muted);
      white-space: nowrap;
    }

    /* Main layout */
    .main {
      flex: 1;
      display: flex;
      overflow: hidden;
    }

    /* Canvas */
    #canvas {
      flex: 1;
      position: relative;
      display: flex;
      align-items: center;
      justify-content: center;
      background: radial-gradient(ellipse at center, #0f0f1a 0%, var(--bg) 70%);
    }
    #canvas::before {
      content: '';
      position: absolute;
      inset: 0;
      background-image: radial-gradient(circle, rgba(255,255,255,0.015) 1px, transparent 1px);
      background-size: 30px 30px;
      pointer-events: none;
    }
    .placeholder {
      text-align: center;
      color: var(--text-muted);
      z-index: 1;
    }
    .placeholder h2 {
      font-size: 16px;
      font-weight: 400;
      margin-bottom: 6px;
      color: var(--text-dim);
      max-width: 500px;
    }
    .placeholder p {
      font-size: 13px;
      line-height: 1.5;
    }

    /* Sidebar */
    #sidebar {
      width: 0;
      background: var(--surface);
      border-left: 1px solid var(--border);
      overflow: hidden;
      transition: width 0.25s ease;
      flex-shrink: 0;
    }
    #sidebar.open { width: var(--sidebar-w); }
    .sidebar-inner {
      width: var(--sidebar-w);
      height: 100%;
      display: flex;
      flex-direction: column;
    }
    .sidebar-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 16px;
      border-bottom: 1px solid var(--border);
    }
    .sidebar-title {
      font-size: 13px;
      font-weight: 600;
      color: var(--text);
    }
    .sidebar-close {
      background: none;
      border: none;
      color: var(--text-dim);
      font-size: 18px;
      cursor: pointer;
      padding: 0 4px;
      line-height: 1;
    }
    .sidebar-close:hover { color: var(--text); }
    .sidebar-body {
      flex: 1;
      overflow-y: auto;
      padding: 16px;
      font-size: 13px;
      line-height: 1.5;
      color: var(--text-dim);
    }

    /* Loading / empty */
    .loading { color: var(--text-muted); font-size: 13px; }
    .error { color: var(--red); font-size: 13px; }

    /* SVG Tree */
    .tree-link { fill: none; stroke: #1e1e2a; stroke-width: 1.2; }
    .dep-line { stroke: #f59e0b; stroke-width: 1; stroke-dasharray: 4 3; opacity: 0.35; }
    .node-label { font-size: 11px; }
    .node-label.dim { opacity: 0.5; }
    .node-label.root-label { font-size: 12px; font-weight: 600; }
    .node-label.project-root-label { font-size: 12px; font-weight: 600; }
    .node-glow { filter: drop-shadow(0 0 4px #4a9eff); }
    @keyframes npulse { 0%,100%{opacity:1} 50%{opacity:0.6} }
    .node-pulse { animation: npulse 2.5s ease-in-out infinite; }
    #canvas.has-tree::before { opacity: 0.5; }

    /* Interaction: tooltips, cursor */
    .node-dot { cursor: pointer; }
    #tooltip {
      position: fixed;
      pointer-events: none;
      background: var(--elevated);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 8px 12px;
      font-size: 12px;
      color: var(--text);
      max-width: 320px;
      display: none;
      z-index: 100;
      box-shadow: 0 4px 12px rgba(0,0,0,0.4);
      line-height: 1.4;
    }
    #tooltip .tip-status {
      display: inline-block;
      width: 8px; height: 8px;
      border-radius: 50%;
      margin-right: 6px;
      vertical-align: middle;
    }
    #tooltip .tip-id {
      color: var(--text-muted);
      font-size: 10px;
      margin-top: 4px;
    }

    /* [sl:po3iXlhOhpAtSgZKtRIuj] Detail sidebar panel */
    .sb-status {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 12px;
    }
    .sb-status-dot {
      width: 10px; height: 10px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .sb-status-label {
      text-transform: capitalize;
      font-weight: 600;
      font-size: 13px;
      color: var(--text);
    }
    .sb-summary {
      color: var(--text);
      font-size: 13px;
      margin-bottom: 8px;
      line-height: 1.5;
    }
    .sb-id {
      color: var(--text-muted);
      font-size: 10px;
      font-family: monospace;
      margin-bottom: 16px;
      word-break: break-all;
    }
    .sb-section {
      margin-top: 16px;
      padding-top: 12px;
      border-top: 1px solid var(--border);
    }
    .sb-section-title {
      font-size: 11px;
      font-weight: 600;
      color: var(--text-dim);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 8px;
    }
    .sb-alert {
      padding: 8px 10px;
      background: rgba(239,68,68,0.1);
      border-radius: 4px;
      color: var(--red);
      font-size: 12px;
      margin-bottom: 8px;
    }
    .sb-claim {
      font-size: 11px;
      color: var(--orange);
      margin-bottom: 4px;
    }
    .sb-prop {
      display: flex;
      gap: 8px;
      font-size: 11px;
      padding: 3px 0;
    }
    .sb-prop-key {
      color: var(--text-muted);
      min-width: 60px;
      font-family: monospace;
    }
    .sb-prop-val {
      color: var(--text-dim);
      word-break: break-all;
    }
    .sb-link {
      display: block;
      font-size: 11px;
      font-family: monospace;
      color: var(--accent);
      padding: 2px 0;
      word-break: break-all;
    }
    .sb-ev {
      padding: 6px 8px;
      background: var(--elevated);
      border-radius: 4px;
      font-size: 11px;
      color: var(--text-dim);
      word-break: break-all;
      margin-bottom: 4px;
    }
    .sb-ev-type {
      color: var(--text-muted);
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.3px;
    }
    .sb-ev-ref {
      margin-top: 2px;
      line-height: 1.4;
    }
    .sb-child {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      padding: 3px 0;
      cursor: pointer;
    }
    .sb-child:hover { color: var(--text); }
    .sb-child-dot {
      width: 6px; height: 6px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .sb-dep {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      padding: 3px 0;
    }
    .sb-dep-dot {
      width: 6px; height: 6px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .sb-audit {
      padding: 6px 0;
      border-bottom: 1px solid var(--border);
      font-size: 11px;
    }
    .sb-audit:last-child { border-bottom: none; }
    .sb-audit-action {
      color: var(--text);
      font-weight: 500;
    }
    .sb-audit-time {
      color: var(--text-muted);
      font-size: 10px;
    }
    .sb-audit-detail {
      color: var(--text-dim);
      font-size: 10px;
      margin-top: 2px;
    }
    .sb-timestamps {
      font-size: 10px;
      color: var(--text-muted);
    }
    .sb-timestamps span { display: block; padding: 1px 0; }
    .sb-more-btn {
      background: var(--elevated);
      border: 1px solid var(--border);
      color: var(--text-dim);
      font-size: 11px;
      padding: 4px 10px;
      border-radius: 4px;
      cursor: pointer;
      margin-top: 4px;
    }
    .sb-more-btn:hover { color: var(--text); border-color: var(--text-dim); }

    /* [sl:GhIqTXRAxcDr-d_fKBA15] Progressive disclosure */
    .progress-badge {
      font-size: 9px;
      fill: var(--text-muted);
      text-anchor: middle;
      pointer-events: none;
    }
    .collapse-ring {
      fill: none;
      stroke: var(--text-muted);
      stroke-width: 1;
      stroke-dasharray: 2 2;
      opacity: 0.5;
    }
    #breadcrumbs {
      display: none;
      align-items: center;
      gap: 4px;
      padding: 0 16px;
      height: 28px;
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      font-size: 11px;
      flex-shrink: 0;
      overflow-x: auto;
      white-space: nowrap;
    }
    #breadcrumbs.visible { display: flex; }
    .bc-item {
      color: var(--text-dim);
      cursor: pointer;
      padding: 2px 4px;
      border-radius: 3px;
    }
    .bc-item:hover { color: var(--text); background: var(--elevated); }
    .bc-sep { color: var(--text-muted); font-size: 9px; }
    .bc-current { color: var(--text); font-weight: 600; cursor: default; }
    .bc-current:hover { background: none; }
    #search-wrap {
      position: relative;
      margin-left: 8px;
    }
    #search-input {
      background: var(--elevated);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 3px 8px 3px 24px;
      font-size: 12px;
      font-family: inherit;
      width: 140px;
      transition: width 0.2s ease;
    }
    #search-input:focus { width: 200px; outline: 1px solid var(--accent); }
    #search-input::placeholder { color: var(--text-muted); }
    .search-icon {
      position: absolute;
      left: 7px;
      top: 50%;
      transform: translateY(-50%);
      font-size: 11px;
      color: var(--text-muted);
      pointer-events: none;
    }
    #search-results {
      position: absolute;
      top: 100%;
      left: 0;
      right: 0;
      background: var(--elevated);
      border: 1px solid var(--border);
      border-radius: 0 0 4px 4px;
      max-height: 200px;
      overflow-y: auto;
      display: none;
      z-index: 50;
    }
    .search-result {
      padding: 6px 8px;
      font-size: 11px;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .search-result:hover { background: var(--border); }
    .search-result-dot {
      width: 6px; height: 6px;
      border-radius: 50%;
      flex-shrink: 0;
    }

    /* [sl:1d5O6Zu7PP0v_hPVXQh0i] Knowledge entries view */
    .kb-btn {
      background: var(--elevated);
      border: 1px solid var(--border);
      color: var(--text-dim);
      font-size: 11px;
      font-family: inherit;
      padding: 3px 10px;
      border-radius: 4px;
      cursor: pointer;
      white-space: nowrap;
    }
    .kb-btn:hover { color: var(--text); border-color: var(--text-dim); }
    .kb-entry {
      padding: 10px 0;
      border-bottom: 1px solid var(--border);
      cursor: pointer;
    }
    .kb-entry:last-child { border-bottom: none; }
    .kb-entry:hover .kb-key { color: var(--accent); }
    .kb-key {
      font-size: 13px;
      font-weight: 600;
      color: var(--text);
      font-family: monospace;
    }
    .kb-preview {
      font-size: 11px;
      color: var(--text-dim);
      margin-top: 4px;
      line-height: 1.4;
      display: -webkit-box;
      -webkit-line-clamp: 3;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .kb-meta {
      font-size: 10px;
      color: var(--text-muted);
      margin-top: 4px;
    }
    .kb-content {
      font-size: 12px;
      color: var(--text-dim);
      line-height: 1.6;
      white-space: pre-wrap;
      word-break: break-word;
      font-family: monospace;
    }
    .kb-back {
      background: none;
      border: none;
      color: var(--accent);
      font-size: 11px;
      cursor: pointer;
      padding: 0;
      margin-bottom: 12px;
      font-family: inherit;
    }
    .kb-back:hover { text-decoration: underline; }

    /* [sl:xC8S95YgrF5ea8ztA1Mw3] Timeline scrubber */
    #timeline {
      display: none;
      height: 36px;
      background: var(--surface);
      border-top: 1px solid var(--border);
      padding: 0 16px;
      flex-shrink: 0;
      position: relative;
      user-select: none;
    }
    #timeline.visible { display: block; }
    .tl-track {
      position: absolute;
      left: 16px;
      right: 16px;
      top: 14px;
      height: 4px;
      background: var(--border);
      border-radius: 2px;
    }
    .tl-filled {
      position: absolute;
      left: 0;
      top: 0;
      height: 100%;
      background: var(--accent);
      border-radius: 2px;
      opacity: 0.5;
    }
    .tl-handle {
      position: absolute;
      top: -5px;
      width: 14px;
      height: 14px;
      background: var(--accent);
      border: 2px solid var(--surface);
      border-radius: 50%;
      cursor: grab;
      transform: translateX(-50%);
      z-index: 2;
    }
    .tl-handle:active { cursor: grabbing; }
    .tl-label-left, .tl-label-right {
      position: absolute;
      top: 22px;
      font-size: 9px;
      color: var(--text-muted);
    }
    .tl-label-left { left: 16px; }
    .tl-label-right { right: 16px; }
    .tl-current {
      position: absolute;
      top: 22px;
      font-size: 9px;
      color: var(--accent);
      transform: translateX(-50%);
      white-space: nowrap;
    }
    .tl-reset {
      position: absolute;
      top: 3px;
      right: 16px;
      background: none;
      border: none;
      color: var(--text-muted);
      font-size: 10px;
      cursor: pointer;
      font-family: inherit;
      z-index: 3;
    }
    .tl-reset:hover { color: var(--text); }

    /* [sl:bcrCbXmkHz31A09oiHHGa] Filter controls */
    #filter-bar {
      display: none;
      align-items: center;
      gap: 8px;
      padding: 4px 16px;
      height: 32px;
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      font-size: 11px;
      flex-shrink: 0;
    }
    #filter-bar.visible { display: flex; }
    .filter-toggle {
      background: var(--elevated);
      border: 1px solid var(--border);
      color: var(--text-dim);
      font-size: 10px;
      font-family: inherit;
      padding: 2px 8px;
      border-radius: 3px;
      cursor: pointer;
      white-space: nowrap;
      transition: background 0.15s, color 0.15s;
    }
    .filter-toggle:hover { color: var(--text); }
    .filter-toggle.active { background: var(--accent); color: #fff; border-color: var(--accent); }
    .filter-toggle.active:hover { opacity: 0.9; }
    .filter-sep {
      width: 1px;
      height: 16px;
      background: var(--border);
    }
    .filter-label {
      color: var(--text-muted);
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.3px;
    }

    /* [sl:qWH2XXNd5544CkuiC_X3i] Health bar header */
    .health-wrap {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .confidence-badge {
      display: flex;
      align-items: center;
      gap: 4px;
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 10px;
      border: 1px solid;
      white-space: nowrap;
    }
    .confidence-badge.high { color: var(--green); border-color: rgba(52,211,153,0.3); background: rgba(52,211,153,0.06); }
    .confidence-badge.medium { color: var(--orange); border-color: rgba(245,158,11,0.3); background: rgba(245,158,11,0.06); }
    .confidence-badge.low { color: var(--red); border-color: rgba(239,68,68,0.3); background: rgba(239,68,68,0.06); }
    .confidence-bars {
      display: flex;
      gap: 2px;
      align-items: center;
    }
    .confidence-bar {
      width: 3px;
      border-radius: 1px;
    }
    .checklist-summary {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 10px;
      color: var(--text-muted);
    }
    .cl-count { font-weight: 600; }
    .cl-pass { color: var(--green); }
    .cl-warn { color: var(--orange); }
    .cl-action { color: var(--red); }
  </style>
</head>
<body>
  <header>
    <div class="logo">&#x25C9; GRAPH</div>
    <div class="progress-wrap" id="progress-wrap" style="display:none">
      <div class="progress-track">
        <div class="progress-fill" id="progress-fill"></div>
      </div>
      <span class="progress-label" id="progress-label"></span>
    </div>
    <div class="health-wrap" id="health-wrap" style="display:none"></div>
    <button class="kb-btn" id="kb-btn" onclick="showKnowledge()" style="display:none">Knowledge</button>
    <div id="search-wrap">
      <span class="search-icon">&#x1F50D;</span>
      <input type="text" id="search-input" placeholder="Search nodes\\u2026" autocomplete="off">
      <div id="search-results"></div>
    </div>
    <div class="stats" id="stats"></div>
    <span class="last-activity" id="last-activity"></span>
  </header>
  <div id="breadcrumbs"></div>
  <div id="filter-bar">
    <span class="filter-label">View:</span>
    <button class="filter-toggle active" id="ft-resolved" onclick="toggleFilter('resolved')">Resolved</button>
    <button class="filter-toggle active" id="ft-deps" onclick="toggleFilter('deps')">Deps</button>
    <span class="filter-sep"></span>
    <span class="filter-label">Status:</span>
    <button class="filter-toggle" id="ft-actionable" onclick="toggleFilter('actionable')">Actionable</button>
    <button class="filter-toggle" id="ft-blocked" onclick="toggleFilter('blocked')">Blocked</button>
    <button class="filter-toggle" id="ft-claimed" onclick="toggleFilter('claimed')">Claimed</button>
  </div>
  <div class="main">
    <div id="canvas">
      <div class="placeholder">
        <p class="loading">Loading projects\\u2026</p>
      </div>
    </div>
    <aside id="sidebar">
      <div class="sidebar-inner">
        <div class="sidebar-header">
          <span class="sidebar-title" id="sidebar-title">Details</span>
          <button class="sidebar-close" onclick="closeSidebar()">&times;</button>
        </div>
        <div class="sidebar-body" id="sidebar-body"></div>
      </div>
    </aside>
  </div>
  <div id="timeline">
    <div class="tl-track" id="tl-track">
      <div class="tl-filled" id="tl-filled"></div>
      <div class="tl-handle" id="tl-handle"></div>
    </div>
    <span class="tl-label-left" id="tl-label-left"></span>
    <span class="tl-label-right" id="tl-label-right"></span>
    <span class="tl-current" id="tl-current"></span>
    <button class="tl-reset" id="tl-reset" onclick="resetTimeline()">Reset</button>
  </div>
  <div id="tooltip"></div>
  <script src="https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js"></script>
  <script>
    // [sl:GhIqTXRAxcDr-d_fKBA15] Progressive disclosure state
    // [sl:bcrCbXmkHz31A09oiHHGa] Filter controls state
    var G = { projects: [], tree: null, onboard: null, statuses: null,
              expanded: {}, focusRoot: null, maxDepth: 2,
              filters: { resolved: true, deps: true, actionable: false, blocked: false, claimed: false },
              timeFilter: null, timeRange: null };

    function loadGraph() {
      Promise.all([
        fetch('/api/tree').then(function(r) { return r.json(); }),
        fetch('/api/onboard').then(function(r) { return r.json(); }),
        fetch('/api/projects').then(function(r) { return r.json(); })
      ]).then(function(results) {
        G.tree = results[0];
        G.onboard = results[1];
        G.projects = results[2];
        G.focusRoot = null;
        if (!G.tree.nodes || G.tree.nodes.length <= 1) {
          showEmpty();
          return;
        }
        /* Auto-expand: __root__ + project roots + nodes up to maxDepth */
        G.expanded = { '__root__': true };
        G.tree.nodes.forEach(function(n) {
          if (n.parent === '__root__' || n.depth < G.maxDepth) G.expanded[n.id] = true;
        });
        document.title = 'Graph';
        document.getElementById('kb-btn').style.display = '';
        showFilterBar();
        renderHeader();
        renderCanvas();
      }).catch(function() {
        document.getElementById('canvas').innerHTML =
          '<div class="placeholder"><p class="error">Failed to connect to server</p></div>';
      });
    }

    function renderHeader() {
      var s = G.onboard.summary;
      /* Exclude project root nodes from progress — matches graph_status behavior */
      var projRoots = G.tree.nodes.filter(function(n) { return n.parent === '__root__'; });
      var rootResolved = projRoots.filter(function(n) { return n.resolved; }).length;
      var total = s.total - projRoots.length;
      var resolved = s.resolved - rootResolved;
      var pct = total > 0 ? Math.round(resolved / total * 100) : 0;
      if (pct > 100) pct = 100;

      document.getElementById('progress-wrap').style.display = 'flex';
      var fill = document.getElementById('progress-fill');
      fill.style.width = pct + '%';
      fill.style.background = pctColor(pct);
      document.getElementById('progress-label').textContent =
        pct + '% (' + resolved + '/' + total + ')';

      document.getElementById('stats').innerHTML =
        statHtml('actionable', s.actionable, 'actionable') +
        statHtml('blocked', s.blocked, 'blocked');

      var la = document.getElementById('last-activity');
      if (G.onboard.last_activity) {
        la.textContent = timeAgo(G.onboard.last_activity);
      }

      /* Continuity confidence + checklist */
      var hw = document.getElementById('health-wrap');
      if (G.onboard.continuity) {
        var c = G.onboard.continuity;
        var barsHtml = confidenceBars(c.score);
        hw.innerHTML =
          '<span class="confidence-badge ' + c.confidence + '" title="Score: ' + c.score + '/100' +
          (c.reasons.length > 0 ? '\\n' + c.reasons.join('\\n') : '') + '">' +
          barsHtml + ' ' + c.confidence + '</span>';
        if (G.onboard.checklist) {
          var cl = G.onboard.checklist;
          var clHtml = '<span class="checklist-summary">';
          if (cl.pass > 0) clHtml += '<span class="cl-count cl-pass">' + cl.pass + '</span>pass';
          if (cl.warn > 0) clHtml += ' <span class="cl-count cl-warn">' + cl.warn + '</span>warn';
          if (cl.action > 0) clHtml += ' <span class="cl-count cl-action">' + cl.action + '</span>action';
          clHtml += '</span>';
          hw.innerHTML += clHtml;
        }
        hw.style.display = 'flex';
      }
    }

    function confidenceBars(score) {
      var count = score >= 80 ? 5 : score >= 60 ? 4 : score >= 40 ? 3 : score >= 20 ? 2 : 1;
      var color = score >= 70 ? 'var(--green)' : score >= 40 ? 'var(--orange)' : 'var(--red)';
      var html = '<span class="confidence-bars">';
      for (var i = 0; i < 5; i++) {
        var h = 6 + i * 2;
        var bg = i < count ? color : 'var(--border)';
        html += '<span class="confidence-bar" style="height:'+h+'px;background:'+bg+'"></span>';
      }
      html += '</span>';
      return html;
    }

    /* --- D3 radial tree renderer --- */
    var STATUS_COLORS = {
      resolved: '#34d399', actionable: '#4a9eff', blocked: '#ef4444',
      claimed: '#f59e0b', pending: '#44445a'
    };

    function computeStatuses(tree) {
      var nodeMap = {};
      tree.nodes.forEach(function(n) { nodeMap[n.id] = n; });
      var hasUnresolvedChild = {};
      tree.nodes.forEach(function(n) {
        if (n.parent && !n.resolved) hasUnresolvedChild[n.parent] = true;
      });
      var depTargets = {};
      tree.edges.forEach(function(e) {
        if (e.type === 'depends_on') {
          if (!depTargets[e.from_node]) depTargets[e.from_node] = [];
          depTargets[e.from_node].push(e.to_node);
        }
      });
      var out = {};
      tree.nodes.forEach(function(n) {
        if (n.resolved) { out[n.id] = 'resolved'; }
        else if (n.blocked) { out[n.id] = 'blocked'; }
        else if (n.properties && n.properties._claimed_by) { out[n.id] = 'claimed'; }
        else if (!hasUnresolvedChild[n.id]) {
          var deps = depTargets[n.id] || [];
          var ok = deps.every(function(did) { var dep = nodeMap[did]; return dep && dep.resolved; });
          out[n.id] = ok ? 'actionable' : 'blocked';
        } else { out[n.id] = 'pending'; }
      });
      return out;
    }

    function truncLabel(s, max) {
      if (!s) return '';
      return s.length > max ? s.substring(0, max) + '...' : s;
    }

    // [sl:GCMs0ESGIaddKxbskXXd3] Graph interaction — zoom/pan, click-to-focus, tooltips
    // [sl:GhIqTXRAxcDr-d_fKBA15] Progressive disclosure — collapse/expand, badges, breadcrumbs, search

    /* Compute subtree stats for a node (from full tree) */
    function subtreeStats(nodeId) {
      var childMap = {};
      G.tree.nodes.forEach(function(n) {
        if (n.parent) {
          if (!childMap[n.parent]) childMap[n.parent] = [];
          childMap[n.parent].push(n.id);
        }
      });
      var nodeMap = {};
      G.tree.nodes.forEach(function(n) { nodeMap[n.id] = n; });
      var total = 0, resolved = 0;
      var stack = childMap[nodeId] ? childMap[nodeId].slice() : [];
      while (stack.length > 0) {
        var id = stack.pop();
        var n = nodeMap[id];
        if (!n) continue;
        total++;
        if (n.resolved) resolved++;
        if (childMap[id]) {
          for (var i = 0; i < childMap[id].length; i++) stack.push(childMap[id][i]);
        }
      }
      return { total: total, resolved: resolved };
    }

    /* Filter to visible nodes based on expanded state + filters */
    function visibleNodes() {
      var visible = [];
      var nodeMap = {};
      G.tree.nodes.forEach(function(n) { nodeMap[n.id] = n; });
      var statuses = G.statuses || computeStatuses(G.tree);
      var statusFilter = G.filters.actionable || G.filters.blocked || G.filters.claimed;
      G.tree.nodes.forEach(function(n) {
        /* Always show root */
        if (!n.parent) { visible.push(n); return; }
        /* Hide resolved if filter is off */
        if (!G.filters.resolved && n.resolved) return;
        /* Status filter: if any status toggle is active, only show matching */
        if (statusFilter) {
          var s = statuses[n.id];
          if (!(G.filters.actionable && s === 'actionable') &&
              !(G.filters.blocked && s === 'blocked') &&
              !(G.filters.claimed && s === 'claimed') &&
              !(s === 'pending' || s === 'resolved')) {
            return;
          }
          /* If filtering by status, always show matching nodes even if resolved hidden */
          /* But still check resolved filter for resolved nodes */
        }
        /* Show if all ancestors are expanded */
        var cur = n.parent;
        var show = true;
        while (cur) {
          if (!G.expanded[cur]) { show = false; break; }
          var p = nodeMap[cur];
          cur = p ? p.parent : null;
        }
        if (show) visible.push(n);
      });
      /* Ensure parents of visible nodes are included (so d3.stratify works) */
      var visibleIds = {};
      visible.forEach(function(n) { visibleIds[n.id] = true; });
      var added = true;
      while (added) {
        added = false;
        visible.forEach(function(n) {
          if (n.parent && !visibleIds[n.parent]) {
            var p = nodeMap[n.parent];
            if (p) {
              visible.push(p);
              visibleIds[p.id] = true;
              added = true;
            }
          }
        });
      }
      return visible;
    }

    /* Check if a node has hidden children */
    function hasCollapsedChildren(nodeId) {
      if (G.expanded[nodeId]) return false;
      for (var i = 0; i < G.tree.nodes.length; i++) {
        if (G.tree.nodes[i].parent === nodeId) return true;
      }
      return false;
    }

    function renderCanvas() {
      var el = document.getElementById('canvas');
      el.innerHTML = '';
      el.classList.remove('has-tree');
      if (!G.tree || !G.tree.nodes || G.tree.nodes.length === 0) return;

      /* D3 not loaded — fallback */
      if (typeof d3 === 'undefined') {
        el.innerHTML = '<div class="placeholder"><h2>' + esc(G.onboard.goal) + '</h2>' +
          '<p>' + G.tree.stats.total + ' nodes (D3 not loaded)</p></div>';
        return;
      }

      var statuses = computeStatuses(G.tree);
      G.statuses = statuses;

      /* Filter to visible nodes only */
      var vNodes = visibleNodes();
      if (vNodes.length === 0) return;

      var root = d3.stratify()
        .id(function(d) { return d.id; })
        .parentId(function(d) { return d.parent; })
        (vNodes);

      var w = el.clientWidth;
      var h = el.clientHeight;
      var R = Math.min(w, h) / 2 - 140;
      if (R < 60) R = 60;

      d3.tree()
        .size([2 * Math.PI, R])
        .separation(function(a, b) { return (a.parent == b.parent ? 1 : 2) / a.depth; })
        (root);

      var svg = d3.select(el).append('svg')
        .attr('width', w).attr('height', h)
        .style('position', 'absolute').style('top', '0').style('left', '0');

      /* Zoom/pan behavior */
      var zoomBehavior = d3.zoom()
        .scaleExtent([0.3, 5])
        .on('zoom', function(event) {
          g.attr('transform', event.transform);
        });
      svg.call(zoomBehavior);

      /* Group layer — must exist before initial transform triggers zoom handler */
      var g = svg.append('g');

      /* Initial transform: centered */
      var initTransform = d3.zoomIdentity.translate(w/2, h/2);
      svg.call(zoomBehavior.transform, initTransform);

      /* Click on background to close sidebar */
      svg.on('click', function(event) {
        if (event.target === svg.node()) {
          closeSidebar();
          hideTooltip();
        }
      });

      /* Parent-child links */
      g.append('g').selectAll('path')
        .data(root.links())
        .join('path')
        .attr('class', 'tree-link')
        .attr('d', d3.linkRadial()
          .angle(function(d) { return d.x; })
          .radius(function(d) { return d.y; }));

      /* Dependency edges (dashed) — only between visible nodes, respects filter */
      var nodeById = {};
      root.descendants().forEach(function(d) { nodeById[d.data.id] = d; });
      if (G.filters.deps) {
        var deps = G.tree.edges.filter(function(e) {
          return e.type === 'depends_on' && nodeById[e.from_node] && nodeById[e.to_node];
        });
        g.append('g').selectAll('line')
          .data(deps)
          .join('line')
          .attr('class', 'dep-line')
          .attr('x1', function(e) { var d = nodeById[e.from_node]; return d.y * Math.cos(d.x - Math.PI/2); })
          .attr('y1', function(e) { var d = nodeById[e.from_node]; return d.y * Math.sin(d.x - Math.PI/2); })
          .attr('x2', function(e) { var d = nodeById[e.to_node]; return d.y * Math.cos(d.x - Math.PI/2); })
          .attr('y2', function(e) { var d = nodeById[e.to_node]; return d.y * Math.sin(d.x - Math.PI/2); });
      }

      /* Nodes */
      var node = g.append('g').selectAll('g')
        .data(root.descendants())
        .join('g')
        .attr('transform', function(d) {
          if (d.depth === 0) return 'translate(0,0)';
          return 'rotate(' + (d.x * 180 / Math.PI - 90) + ') translate(' + d.y + ',0)';
        });

      node.append('circle')
        .attr('r', function(d) {
          if (d.depth === 0) return 7;
          if (d.data.parent === '__root__') return 6;
          return d.children ? 5 : 3.5;
        })
        .attr('fill', function(d) { return STATUS_COLORS[statuses[d.data.id]] || '#44445a'; })
        .attr('class', function(d) {
          var s = statuses[d.data.id];
          var c = 'node-dot';
          if (s === 'actionable') c += ' node-glow node-pulse';
          return c;
        })
        .on('click', function(event, d) {
          event.stopPropagation();
          hideTooltip();
          focusNode(d, svg, zoomBehavior, w, h);
          showNodeSidebar(d);
        })
        .on('dblclick', function(event, d) {
          event.stopPropagation();
          toggleExpand(d.data.id);
        })
        .on('mouseenter', function(event, d) { showTooltip(event, d); })
        .on('mouseleave', function() { hideTooltip(); });

      /* Collapsed parent indicator: dashed ring + progress badge */
      node.each(function(d) {
        if (!hasCollapsedChildren(d.data.id)) return;
        var sel = d3.select(this);
        var r = d.depth === 0 ? 7 : d.data.parent === '__root__' ? 6 : (d.children ? 5 : 3.5);
        sel.append('circle')
          .attr('class', 'collapse-ring')
          .attr('r', r + 5);
        var stats = subtreeStats(d.data.id);
        if (stats.total > 0) {
          sel.append('text')
            .attr('class', 'progress-badge')
            .attr('dy', r + 15)
            .text(stats.resolved + '/' + stats.total);
        }
      });

      /* Labels — always upright */
      node.append('text')
        .attr('class', function(d) {
          var c = 'node-label';
          if (statuses[d.data.id] === 'resolved') c += ' dim';
          if (d.depth === 0) c += ' root-label';
          else if (d.data.parent === '__root__') c += ' project-root-label';
          return c;
        })
        .attr('dy', function(d) { return d.depth === 0 ? '-14' : '0.31em'; })
        .attr('x', function(d) {
          if (d.depth === 0) return 0;
          return d.x < Math.PI ? 8 : -8;
        })
        .attr('text-anchor', function(d) {
          if (d.depth === 0) return 'middle';
          return d.x < Math.PI ? 'start' : 'end';
        })
        .attr('transform', function(d) {
          if (d.depth === 0) return null;
          return d.x >= Math.PI ? 'rotate(180)' : null;
        })
        .attr('fill', function(d) {
          return statuses[d.data.id] === 'resolved' ? '#6a6a80' : '#e0e0e8';
        })
        .text(function(d) { return truncLabel(d.data.summary, d.depth === 0 ? 60 : 35); })
        .style('pointer-events', 'none');

      /* Apply time filter opacity */
      applyTimeOpacity(node);

      el.classList.add('has-tree');

      /* Store D3 state */
      G.d3 = { svg: svg, g: g, root: root, nodeById: nodeById, zoom: zoomBehavior };

      /* Update breadcrumbs + timeline */
      renderBreadcrumbs();
      renderTimeline();
    }

    /* Toggle expand/collapse on a node */
    function toggleExpand(nodeId) {
      if (G.expanded[nodeId]) {
        /* Collapse: remove this node and all descendants from expanded */
        delete G.expanded[nodeId];
        collapseDescendants(nodeId);
      } else {
        /* Expand: add this node */
        G.expanded[nodeId] = true;
      }
      renderCanvas();
    }

    function collapseDescendants(nodeId) {
      G.tree.nodes.forEach(function(n) {
        if (n.parent === nodeId) {
          delete G.expanded[n.id];
          collapseDescendants(n.id);
        }
      });
    }

    /* Expand all ancestors of a node (for search drill-in) */
    function expandToNode(nodeId) {
      var nodeMap = {};
      G.tree.nodes.forEach(function(n) { nodeMap[n.id] = n; });
      var n = nodeMap[nodeId];
      if (!n) return;
      var cur = n.parent;
      while (cur) {
        G.expanded[cur] = true;
        var p = nodeMap[cur];
        cur = p ? p.parent : null;
      }
    }

    /* Breadcrumb rendering */
    function renderBreadcrumbs() {
      var el = document.getElementById('breadcrumbs');
      if (!G.focusRoot || !G.tree) {
        el.classList.remove('visible');
        return;
      }
      var nodeMap = {};
      G.tree.nodes.forEach(function(n) { nodeMap[n.id] = n; });
      var chain = [];
      var cur = G.focusRoot;
      while (cur) {
        var n = nodeMap[cur];
        if (!n) break;
        chain.unshift(n);
        cur = n.parent;
      }
      if (chain.length <= 1) { el.classList.remove('visible'); return; }
      var html = '';
      chain.forEach(function(n, i) {
        if (i > 0) html += '<span class="bc-sep">&#x25B8;</span>';
        if (i === chain.length - 1) {
          html += '<span class="bc-current">' + esc(truncLabel(n.summary, 30)) + '</span>';
        } else {
          html += '<span class="bc-item" onclick="drillTo(\\''+n.id+'\\')\">' + esc(truncLabel(n.summary, 25)) + '</span>';
        }
      });
      el.innerHTML = html;
      el.classList.add('visible');
    }

    function drillTo(nodeId) {
      G.focusRoot = (nodeId === G.tree.root_id || nodeId === '__root__') ? null : nodeId;
      expandToNode(nodeId);
      renderCanvas();
      /* Focus the node */
      if (G.d3 && G.d3.nodeById && G.d3.nodeById[nodeId]) {
        var el = document.getElementById('canvas');
        focusNode(G.d3.nodeById[nodeId], G.d3.svg, G.d3.zoom, el.clientWidth, el.clientHeight);
      }
    }

    /* Focus: smooth zoom to center a node */
    function focusNode(d, svg, zoomBehavior, w, h) {
      var nx, ny;
      if (d.depth === 0) { nx = 0; ny = 0; }
      else {
        nx = d.y * Math.cos(d.x - Math.PI/2);
        ny = d.y * Math.sin(d.x - Math.PI/2);
      }
      var scale = 1.5;
      var tx = w/2 - nx * scale;
      var ty = h/2 - ny * scale;
      svg.transition().duration(500).call(
        zoomBehavior.transform,
        d3.zoomIdentity.translate(tx, ty).scale(scale)
      );
    }

    /* Tooltip */
    function showTooltip(event, d) {
      var tip = document.getElementById('tooltip');
      var status = G.statuses[d.data.id] || 'pending';
      var color = STATUS_COLORS[status] || '#44445a';
      tip.innerHTML =
        '<span class="tip-status" style="background:' + color + '"></span>' +
        '<strong>' + esc(d.data.summary) + '</strong>' +
        '<div class="tip-id">' + status + ' &middot; ' + d.data.id.substring(0, 8) + '&hellip;</div>';
      tip.style.display = 'block';
      positionTooltip(event);
    }

    function positionTooltip(event) {
      var tip = document.getElementById('tooltip');
      var x = event.clientX + 14;
      var y = event.clientY + 14;
      /* Keep tooltip within viewport */
      var tw = tip.offsetWidth;
      var th = tip.offsetHeight;
      if (x + tw > window.innerWidth - 8) x = event.clientX - tw - 8;
      if (y + th > window.innerHeight - 8) y = event.clientY - th - 8;
      tip.style.left = x + 'px';
      tip.style.top = y + 'px';
    }

    function hideTooltip() {
      document.getElementById('tooltip').style.display = 'none';
    }

    // [sl:po3iXlhOhpAtSgZKtRIuj] Detail sidebar panel
    function showNodeSidebar(d) {
      var status = G.statuses[d.data.id] || 'pending';
      var color = STATUS_COLORS[status] || '#44445a';
      var n = d.data;
      var html = '';

      /* Status + summary */
      html += '<div class="sb-status">' +
        '<span class="sb-status-dot" style="background:' + color + '"></span>' +
        '<span class="sb-status-label">' + status + '</span></div>';
      html += '<div class="sb-summary">' + esc(n.summary) + '</div>';
      html += '<div class="sb-id">' + n.id + '</div>';

      /* Blocked reason */
      if (n.blocked_reason) {
        html += '<div class="sb-alert">' + esc(n.blocked_reason) + '</div>';
      }

      /* Claimed by */
      if (n.properties && n.properties._claimed_by) {
        html += '<div class="sb-claim">Claimed by ' + esc(n.properties._claimed_by) + '</div>';
      }

      /* Project overview for project root nodes */
      if (n.parent === '__root__' && n._project) {
        html += '<div class="sb-section"><div class="sb-section-title">Project Overview</div>' +
          '<div id="sb-project-onboard"><span class="loading">Loading&hellip;</span></div></div>';
      }

      /* Dependencies */
      var depsOut = G.tree.edges.filter(function(e) { return e.type === 'depends_on' && e.from_node === n.id; });
      var depsIn = G.tree.edges.filter(function(e) { return e.type === 'depends_on' && e.to_node === n.id; });
      if (depsOut.length > 0 || depsIn.length > 0) {
        html += '<div class="sb-section"><div class="sb-section-title">Dependencies</div>';
        if (depsOut.length > 0) {
          html += '<div style="font-size:10px;color:var(--text-muted);margin-bottom:4px">Depends on:</div>';
          depsOut.forEach(function(e) {
            var tn = findTreeNode(e.to_node);
            var ds = G.statuses[e.to_node] || 'pending';
            var dc = STATUS_COLORS[ds] || '#44445a';
            html += '<div class="sb-dep">' +
              '<span class="sb-dep-dot" style="background:' + dc + '"></span>' +
              esc(tn ? truncLabel(tn.summary, 42) : e.to_node.substring(0, 8)) + '</div>';
          });
        }
        if (depsIn.length > 0) {
          html += '<div style="font-size:10px;color:var(--text-muted);margin-bottom:4px;margin-top:6px">Depended on by:</div>';
          depsIn.forEach(function(e) {
            var fn = findTreeNode(e.from_node);
            var ds = G.statuses[e.from_node] || 'pending';
            var dc = STATUS_COLORS[ds] || '#44445a';
            html += '<div class="sb-dep">' +
              '<span class="sb-dep-dot" style="background:' + dc + '"></span>' +
              esc(fn ? truncLabel(fn.summary, 42) : e.from_node.substring(0, 8)) + '</div>';
          });
        }
        html += '</div>';
      }

      /* Children */
      if (d.children && d.children.length > 0) {
        html += '<div class="sb-section"><div class="sb-section-title">Children (' + d.children.length + ')</div>';
        d.children.forEach(function(c) {
          var cs = G.statuses[c.data.id] || 'pending';
          var cc = STATUS_COLORS[cs] || '#44445a';
          html += '<div class="sb-child" onclick="clickChildNode(\\''+c.data.id+'\\')"><span class="sb-child-dot" style="background:' + cc + '"></span>' +
            esc(truncLabel(c.data.summary, 42)) + '</div>';
        });
        html += '</div>';
      }

      /* Properties (exclude internal _ prefixed) */
      var props = n.properties || {};
      var propKeys = Object.keys(props).filter(function(k) { return k.charAt(0) !== '_'; });
      if (propKeys.length > 0) {
        html += '<div class="sb-section"><div class="sb-section-title">Properties</div>';
        propKeys.forEach(function(k) {
          html += '<div class="sb-prop"><span class="sb-prop-key">' + esc(k) + '</span>' +
            '<span class="sb-prop-val">' + esc(String(props[k])) + '</span></div>';
        });
        html += '</div>';
      }

      /* Context links */
      var links = n.context_links || [];
      if (links.length > 0) {
        html += '<div class="sb-section"><div class="sb-section-title">Context Links</div>';
        links.forEach(function(link) {
          html += '<span class="sb-link">' + esc(link) + '</span>';
        });
        html += '</div>';
      }

      /* Evidence */
      var evs = n.evidence || [];
      if (evs.length > 0) {
        html += '<div class="sb-section"><div class="sb-section-title">Evidence (' + evs.length + ')</div>';
        evs.forEach(function(ev) {
          html += '<div class="sb-ev"><div class="sb-ev-type">' + esc(ev.type) +
            (ev.agent ? ' &middot; ' + esc(ev.agent) : '') +
            (ev.timestamp ? ' &middot; ' + timeAgo(ev.timestamp) : '') +
            '</div><div class="sb-ev-ref">' + esc(ev.ref ? ev.ref.substring(0, 500) : '') + '</div></div>';
        });
        html += '</div>';
      }

      /* Timestamps */
      html += '<div class="sb-section"><div class="sb-section-title">Timestamps</div>' +
        '<div class="sb-timestamps">' +
        '<span>Created: ' + (n.created_at ? formatTime(n.created_at) : '?') + '</span>' +
        '<span>Updated: ' + (n.updated_at ? formatTime(n.updated_at) + ' (' + timeAgo(n.updated_at) + ')' : '?') + '</span>' +
        '</div></div>';

      /* Audit history — loaded async */
      html += '<div class="sb-section"><div class="sb-section-title">Audit History</div>' +
        '<div id="sb-audit-list"><span class="loading">Loading&hellip;</span></div></div>';

      openSidebar(truncLabel(n.summary, 40), html);

      /* Fetch project onboard for project roots */
      if (n.parent === '__root__' && n._project) {
        fetch('/api/projects/' + encodeURIComponent(n._project) + '/onboard')
          .then(function(r) { return r.json(); })
          .then(function(ob) {
            var el = document.getElementById('sb-project-onboard');
            if (!el) return;
            var pTotal = ob.summary.total - 1;
            var pResolved = ob.summary.resolved - (n.resolved ? 1 : 0);
            var pPct = pTotal > 0 ? Math.round(pResolved / pTotal * 100) : 0;
            var h = '<div style="margin-bottom:8px">' + pResolved + '/' + pTotal + ' resolved (' + pPct + '%)</div>';
            h += '<div style="margin-bottom:4px"><span style="color:var(--accent)">' + ob.summary.actionable + '</span> actionable, <span style="color:var(--red)">' + ob.summary.blocked + '</span> blocked</div>';
            if (ob.continuity) {
              h += '<div class="confidence-badge ' + ob.continuity.confidence + '" style="display:inline-flex;margin:6px 0">' +
                confidenceBars(ob.continuity.score) + ' ' + ob.continuity.confidence + ' (' + ob.continuity.score + ')</div>';
            }
            if (ob.last_activity) {
              h += '<div style="font-size:10px;color:var(--text-muted);margin-top:4px">Last activity: ' + timeAgo(ob.last_activity) + '</div>';
            }
            el.innerHTML = h;
          })
          .catch(function() {
            var el = document.getElementById('sb-project-onboard');
            if (el) el.innerHTML = '<span class="error">Failed to load</span>';
          });
      }

      /* Fetch audit history */
      fetch('/api/nodes/' + encodeURIComponent(n.id) + '/history')
        .then(function(r) { return r.json(); })
        .then(function(events) {
          var el = document.getElementById('sb-audit-list');
          if (!el) return;
          if (events.length === 0) {
            el.innerHTML = '<span style="color:var(--text-muted);font-size:11px">No history</span>';
            return;
          }
          var h = '';
          events.slice(0, 20).forEach(function(ev) {
            h += '<div class="sb-audit">' +
              '<div><span class="sb-audit-action">' + esc(ev.action) + '</span> ' +
              '<span class="sb-audit-time">' + timeAgo(ev.timestamp) + '</span></div>';
            if (ev.changes && typeof ev.changes === 'object') {
              var keys = Object.keys(ev.changes);
              if (keys.length > 0 && keys.length <= 5) {
                h += '<div class="sb-audit-detail">Changed: ' + keys.join(', ') + '</div>';
              }
            }
            h += '</div>';
          });
          if (events.length > 20) {
            h += '<div style="font-size:10px;color:var(--text-muted);padding-top:4px">+ ' + (events.length - 20) + ' more</div>';
          }
          el.innerHTML = h;
        })
        .catch(function() {
          var el = document.getElementById('sb-audit-list');
          if (el) el.innerHTML = '<span class="error">Failed to load</span>';
        });
    }

    function findTreeNode(id) {
      if (!G.tree || !G.tree.nodes) return null;
      for (var i = 0; i < G.tree.nodes.length; i++) {
        if (G.tree.nodes[i].id === id) return G.tree.nodes[i];
      }
      return null;
    }

    function clickChildNode(id) {
      if (!G.d3 || !G.d3.nodeById) return;
      var d = G.d3.nodeById[id];
      if (!d) return;
      var el = document.getElementById('canvas');
      focusNode(d, G.d3.svg, G.d3.zoom, el.clientWidth, el.clientHeight);
      showNodeSidebar(d);
    }

    function formatTime(iso) {
      try {
        var d = new Date(iso);
        return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
      } catch(e) { return iso; }
    }

    var _resizeTimer;
    window.addEventListener('resize', function() {
      clearTimeout(_resizeTimer);
      _resizeTimer = setTimeout(function() { if (G.tree) renderCanvas(); }, 200);
    });

    function showEmpty() {
      document.getElementById('canvas').innerHTML =
        '<div class="placeholder"><h2>No projects yet</h2>' +
        '<p>Create a project with graph_open to get started</p></div>';
    }

    function statHtml(cls, value, label) {
      return '<span class="stat">' +
        '<span class="stat-dot ' + cls + '"></span>' +
        '<span class="stat-value">' + value + '</span> ' + label + '</span>';
    }

    function pctColor(p) {
      if (p < 25) return '#ef4444';
      if (p < 50) return '#f59e0b';
      if (p < 75) return '#4a9eff';
      return '#34d399';
    }

    function timeAgo(iso) {
      var ms = Date.now() - new Date(iso).getTime();
      var s = Math.floor(ms / 1000);
      if (s < 60) return 'just now';
      var m = Math.floor(s / 60);
      if (m < 60) return m + 'm ago';
      var h = Math.floor(m / 60);
      if (h < 24) return h + 'h ago';
      return Math.floor(h / 24) + 'd ago';
    }

    function esc(s) {
      var d = document.createElement('div');
      d.textContent = s || '';
      return d.innerHTML;
    }

    function openSidebar(title, html) {
      document.getElementById('sidebar-title').textContent = title || 'Details';
      document.getElementById('sidebar-body').innerHTML = html || '';
      document.getElementById('sidebar').classList.add('open');
    }

    function closeSidebar() {
      document.getElementById('sidebar').classList.remove('open');
    }

    /* Search */
    var _searchTimer;
    function initSearch() {
      var input = document.getElementById('search-input');
      var results = document.getElementById('search-results');
      input.addEventListener('input', function() {
        clearTimeout(_searchTimer);
        _searchTimer = setTimeout(function() { runSearch(input.value); }, 150);
      });
      input.addEventListener('focus', function() {
        if (input.value.length > 0) runSearch(input.value);
      });
      input.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
          input.value = '';
          results.style.display = 'none';
          input.blur();
        }
      });
      document.addEventListener('click', function(e) {
        if (!e.target.closest('#search-wrap')) results.style.display = 'none';
      });
    }

    function runSearch(query) {
      var results = document.getElementById('search-results');
      if (!query || query.length < 2 || !G.tree) {
        results.style.display = 'none';
        return;
      }
      var q = query.toLowerCase();
      var matches = G.tree.nodes.filter(function(n) {
        return n.summary.toLowerCase().indexOf(q) !== -1;
      }).slice(0, 10);
      if (matches.length === 0) {
        results.innerHTML = '<div style="padding:8px;font-size:11px;color:var(--text-muted)">No matches</div>';
        results.style.display = 'block';
        return;
      }
      var html = '';
      matches.forEach(function(n) {
        var s = G.statuses ? G.statuses[n.id] || 'pending' : 'pending';
        var c = STATUS_COLORS[s] || '#44445a';
        html += '<div class="search-result" onclick="searchSelect(\\''+n.id+'\\')"><span class="search-result-dot" style="background:'+c+'"></span>' +
          esc(truncLabel(n.summary, 50)) + '</div>';
      });
      results.innerHTML = html;
      results.style.display = 'block';
    }

    function searchSelect(nodeId) {
      document.getElementById('search-results').style.display = 'none';
      document.getElementById('search-input').value = '';
      /* Expand ancestors so node is visible */
      expandToNode(nodeId);
      renderCanvas();
      /* Focus the node */
      if (G.d3 && G.d3.nodeById && G.d3.nodeById[nodeId]) {
        var el = document.getElementById('canvas');
        focusNode(G.d3.nodeById[nodeId], G.d3.svg, G.d3.zoom, el.clientWidth, el.clientHeight);
        showNodeSidebar(G.d3.nodeById[nodeId]);
      }
    }

    /* [sl:xC8S95YgrF5ea8ztA1Mw3] Timeline scrubber */
    function applyTimeOpacity(nodeSelection) {
      if (!G.timeFilter) return;
      var t = new Date(G.timeFilter).getTime();
      nodeSelection.style('opacity', function(d) {
        if (d.depth === 0) return 1;
        var created = new Date(d.data.created_at).getTime();
        if (created > t) return 0.1; /* Not yet created */
        var updated = new Date(d.data.updated_at).getTime();
        if (d.data.resolved && updated <= t) return 0.4; /* Resolved before this point */
        return 1;
      });
    }

    function renderTimeline() {
      var el = document.getElementById('timeline');
      if (!G.tree || G.tree.nodes.length < 2) { el.classList.remove('visible'); return; }

      /* Compute time range */
      var times = [];
      G.tree.nodes.forEach(function(n) {
        if (n.created_at) times.push(new Date(n.created_at).getTime());
        if (n.updated_at) times.push(new Date(n.updated_at).getTime());
      });
      if (times.length === 0) { el.classList.remove('visible'); return; }
      var minT = Math.min.apply(null, times);
      var maxT = Math.max.apply(null, times);
      if (maxT - minT < 1000) { el.classList.remove('visible'); return; } /* Less than 1s range */
      G.timeRange = { min: minT, max: maxT };

      document.getElementById('tl-label-left').textContent = formatTimeShort(minT);
      document.getElementById('tl-label-right').textContent = formatTimeShort(maxT);

      /* Set handle position */
      var pct = G.timeFilter ? Math.max(0, Math.min(1, (new Date(G.timeFilter).getTime() - minT) / (maxT - minT))) : 1;
      var handle = document.getElementById('tl-handle');
      var filled = document.getElementById('tl-filled');
      handle.style.left = (pct * 100) + '%';
      filled.style.width = (pct * 100) + '%';

      var cur = document.getElementById('tl-current');
      if (G.timeFilter) {
        cur.textContent = formatTimeShort(new Date(G.timeFilter).getTime());
        cur.style.left = 'calc(16px + ' + (pct * 100) + '% * (100% - 32px) / 100%)';
        cur.style.display = '';
      } else {
        cur.style.display = 'none';
      }

      document.getElementById('tl-reset').style.display = G.timeFilter ? '' : 'none';
      el.classList.add('visible');
    }

    function formatTimeShort(ms) {
      var d = new Date(ms);
      var month = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()];
      return month + ' ' + d.getDate() + ' ' + d.getHours().toString().padStart(2,'0') + ':' + d.getMinutes().toString().padStart(2,'0');
    }

    function initTimeline() {
      var track = document.getElementById('tl-track');
      var handle = document.getElementById('tl-handle');
      var dragging = false;

      function onMove(clientX) {
        if (!G.timeRange) return;
        var rect = track.getBoundingClientRect();
        var pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        var t = G.timeRange.min + pct * (G.timeRange.max - G.timeRange.min);
        G.timeFilter = new Date(t).toISOString();
        handle.style.left = (pct * 100) + '%';
        document.getElementById('tl-filled').style.width = (pct * 100) + '%';
        var cur = document.getElementById('tl-current');
        cur.textContent = formatTimeShort(t);
        cur.style.left = (pct * 100) + '%';
        cur.style.display = '';
        /* Re-apply opacity without full re-render for smooth scrubbing */
        if (G.d3 && G.d3.g) {
          G.d3.g.selectAll('g').filter(function(d) { return d && d.data; })
            .style('opacity', function(d) {
              if (d.depth === 0) return 1;
              var created = new Date(d.data.created_at).getTime();
              if (created > t) return 0.1;
              var updated = new Date(d.data.updated_at).getTime();
              if (d.data.resolved && updated <= t) return 0.4;
              return 1;
            });
        }
      }

      handle.addEventListener('mousedown', function(e) {
        e.preventDefault();
        dragging = true;
      });
      track.addEventListener('mousedown', function(e) {
        dragging = true;
        onMove(e.clientX);
      });
      document.addEventListener('mousemove', function(e) {
        if (dragging) onMove(e.clientX);
      });
      document.addEventListener('mouseup', function() {
        if (dragging) {
          dragging = false;
          document.getElementById('tl-reset').style.display = G.timeFilter ? '' : 'none';
        }
      });
    }

    function resetTimeline() {
      G.timeFilter = null;
      renderCanvas();
    }

    /* [sl:bcrCbXmkHz31A09oiHHGa] Filter controls */
    function toggleFilter(key) {
      G.filters[key] = !G.filters[key];
      syncFilterUI();
      persistFilters();
      renderCanvas();
    }

    function syncFilterUI() {
      ['resolved', 'deps', 'actionable', 'blocked', 'claimed'].forEach(function(k) {
        var btn = document.getElementById('ft-' + k);
        if (btn) {
          if (G.filters[k]) btn.classList.add('active');
          else btn.classList.remove('active');
        }
      });
    }

    function persistFilters() {
      var params = new URLSearchParams(window.location.search);
      ['resolved', 'deps', 'actionable', 'blocked', 'claimed'].forEach(function(k) {
        if (G.filters[k]) params.set(k, '1');
        else params.delete(k);
      });
      var qs = params.toString();
      var url = window.location.pathname + (qs ? '?' + qs : '');
      history.replaceState(null, '', url);
    }

    function loadFiltersFromURL() {
      var params = new URLSearchParams(window.location.search);
      ['resolved', 'deps', 'actionable', 'blocked', 'claimed'].forEach(function(k) {
        if (params.has(k)) G.filters[k] = params.get(k) === '1';
      });
      syncFilterUI();
    }

    function showFilterBar() {
      document.getElementById('filter-bar').classList.add('visible');
    }

    /* [sl:1d5O6Zu7PP0v_hPVXQh0i] Knowledge entries view */
    function showKnowledge() {
      openSidebar('Knowledge', '<span class="loading">Loading\\u2026</span>');
      var projects = G.projects || [];
      if (projects.length === 0) {
        document.getElementById('sidebar-body').innerHTML =
          '<div style="color:var(--text-muted);font-size:12px">No knowledge entries</div>';
        return;
      }
      Promise.all(projects.map(function(p) {
        return fetch('/api/projects/' + encodeURIComponent(p.project) + '/knowledge')
          .then(function(r) { return r.json(); })
          .then(function(entries) { return { project: p.project, entries: entries }; });
      })).then(function(results) {
        var allEntries = [];
        results.forEach(function(r) {
          r.entries.forEach(function(e) {
            allEntries.push({ project: r.project, key: e.key, content: e.content, created_by: e.created_by, updated_at: e.updated_at });
          });
        });
        G._knowledgeEntries = allEntries;
        if (allEntries.length === 0) {
          document.getElementById('sidebar-body').innerHTML =
            '<div style="color:var(--text-muted);font-size:12px">No knowledge entries yet</div>';
          return;
        }
        var html = '';
        var curProject = null;
        allEntries.forEach(function(e, i) {
          if (e.project !== curProject) {
            curProject = e.project;
            html += '<div style="font-size:10px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin:12px 0 6px;padding-top:8px;border-top:1px solid var(--border)">' + esc(e.project) + '</div>';
          }
          html += '<div class="kb-entry" onclick="showKnowledgeEntry('+i+')">' +
            '<div class="kb-key">' + esc(e.key) + '</div>' +
            '<div class="kb-preview">' + esc(e.content.substring(0, 200)) + '</div>' +
            '<div class="kb-meta">' + esc(e.created_by) + ' &middot; ' + timeAgo(e.updated_at) + '</div>' +
            '</div>';
        });
        document.getElementById('sidebar-body').innerHTML = html;
      }).catch(function() {
        document.getElementById('sidebar-body').innerHTML =
          '<span class="error">Failed to load knowledge</span>';
      });
    }

    function showKnowledgeEntry(index) {
      var e = G._knowledgeEntries[index];
      if (!e) return;
      var html = '<button class="kb-back" onclick="showKnowledge()">\\u2190 All entries</button>' +
        '<div class="kb-key" style="margin-bottom:8px">' + esc(e.key) + '</div>' +
        '<div class="kb-meta" style="margin-bottom:12px">' + esc(e.created_by || '') + ' &middot; ' + formatTime(e.updated_at) +
        (e.project ? ' &middot; ' + esc(e.project) : '') + '</div>' +
        '<div class="kb-content">' + esc(e.content) + '</div>';
      document.getElementById('sidebar-title').textContent = e.key;
      document.getElementById('sidebar-body').innerHTML = html;
    }

    /* Expose globals */
    window.G = G;
    window.openSidebar = openSidebar;
    window.closeSidebar = closeSidebar;
    window.clickChildNode = clickChildNode;
    window.toggleExpand = toggleExpand;
    window.drillTo = drillTo;
    window.searchSelect = searchSelect;
    window.showKnowledge = showKnowledge;
    window.showKnowledgeEntry = showKnowledgeEntry;
    window.toggleFilter = toggleFilter;
    window.resetTimeline = resetTimeline;

    loadFiltersFromURL();
    initTimeline();
    initSearch();
    loadGraph();
  </script>
</body>
</html>`;

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? "open" :
    process.platform === "win32" ? "start" :
    "xdg-open";
  exec(`${cmd} ${url}`);
}

function discoverDbs(): string[] {
  if (process.env.GRAPH_DB) {
    return existsSync(process.env.GRAPH_DB) ? [process.env.GRAPH_DB] : [];
  }
  const baseDir = join(homedir(), ".graph", "db");
  if (!existsSync(baseDir)) return [];
  const paths: string[] = [];
  for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const dbFile = join(baseDir, entry.name, "graph.db");
      if (existsSync(dbFile)) paths.push(dbFile);
    }
  }
  return paths;
}

function openMergedDb(dbPaths: string[]): Db {
  if (dbPaths.length === 1) {
    return new Database(dbPaths[0], { readonly: true });
  }
  const mem = new Database(":memory:");
  mem.pragma("foreign_keys = OFF");
  for (let i = 0; i < dbPaths.length; i++) {
    const escaped = dbPaths[i].replace(/'/g, "''");
    mem.exec(`ATTACH DATABASE '${escaped}' AS src`);
    if (i === 0) {
      for (const table of ["nodes", "edges", "events", "knowledge"]) {
        const row = mem.prepare(
          "SELECT sql FROM src.sqlite_master WHERE type='table' AND name=?"
        ).get(table) as { sql: string } | undefined;
        if (row) mem.exec(row.sql);
      }
    }
    for (const table of ["nodes", "edges", "events", "knowledge"]) {
      try { mem.exec(`INSERT OR IGNORE INTO ${table} SELECT * FROM src.${table}`); } catch {}
    }
    mem.exec("DETACH src");
  }
  return mem;
}

export function startUi(args: string[]): void {
  // Parse args
  let port = 4747;
  let noOpen = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port" && args[i + 1]) {
      port = parseInt(args[i + 1], 10);
      i++;
    }
    if (args[i] === "--no-open") noOpen = true;
  }
  port = parseInt(process.env.GRAPH_UI_PORT ?? String(port), 10);

  // Discover and merge all Graph databases
  const dbPaths = discoverDbs();
  if (dbPaths.length === 0) {
    console.error("No Graph databases found.");
    console.error("Run Graph in an MCP-enabled project first to create a database.");
    process.exit(1);
  }

  const db = openMergedDb(dbPaths);

  const server = createServer((req, res) => {
    // CORS headers for local dev
    res.setHeader("Access-Control-Allow-Origin", "*");

    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (req.method !== "GET") { notFound(res); return; }

    // Static routes
    if (path === "/" || path === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(HTML);
      return;
    }

    if (path === "/api/health") {
      const projects = (db.prepare("SELECT COUNT(DISTINCT project) as cnt FROM nodes").get() as { cnt: number }).cnt;
      const nodes = (db.prepare("SELECT COUNT(*) as cnt FROM nodes").get() as { cnt: number }).cnt;
      json(res, { version: PKG_VERSION, projects, nodes });
      return;
    }

    // /api/projects
    if (path === "/api/projects") {
      apiProjects(db, res);
      return;
    }

    // /api/tree — unified tree across all projects
    if (path === "/api/tree") {
      apiTree(db, res);
      return;
    }

    // /api/onboard — aggregate onboard across all projects
    if (path === "/api/onboard") {
      apiOnboard(db, res);
      return;
    }

    // /api/projects/:name/tree|knowledge|onboard
    const match = path.match(/^\/api\/projects\/([^/]+)\/(\w+)$/);
    if (match) {
      const project = decodeURIComponent(match[1]);
      const sub = match[2];
      if (sub === "tree") { apiProjectTree(db, project, res); return; }
      if (sub === "knowledge") { apiProjectKnowledge(db, project, res); return; }
      if (sub === "onboard") { apiProjectOnboard(db, project, res); return; }
    }

    // /api/nodes/:id/history
    const nodeMatch = path.match(/^\/api\/nodes\/([^/]+)\/history$/);
    if (nodeMatch) {
      apiNodeHistory(db, decodeURIComponent(nodeMatch[1]), res);
      return;
    }

    notFound(res);
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`\nPort ${port} is already in use. Try: graph ui --port <number>\n`);
    } else {
      console.error("Server error:", err.message);
    }
    db.close();
    process.exit(1);
  });

  server.listen(port, () => {
    console.log(`\n  Graph Dashboard v${PKG_VERSION}`);
    console.log(`  http://localhost:${port}`);
    console.log(`  Databases: ${dbPaths.length}`);
    for (const p of dbPaths) console.log(`    ${p}`);
    console.log(`\n  Press Ctrl+C to stop\n`);
    if (!noOpen) openBrowser(`http://localhost:${port}`);
  });

  const shutdown = () => {
    console.log("\nShutting down...");
    server.close();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
