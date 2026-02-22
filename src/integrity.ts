import { getDb } from "./db.js";
import type { Evidence } from "./types.js";

// [sl:7bQaAQjJZnY7-ItScrtip] Integrity audit — flag per-node data quality issues

export interface IntegrityIssue {
  type: "weak_evidence" | "stale_claim" | "orphan" | "stale_task";
  node_id: string;
  summary: string;
  detail: string;
}

export interface IntegrityResult {
  issues: IntegrityIssue[];
  score: number; // 0-100
  checked_at: string;
}

export function computeIntegrity(project: string): IntegrityResult {
  const db = getDb();
  const issues: IntegrityIssue[] = [];
  const now = new Date();

  // 1. Weak evidence — resolved nodes with no git evidence or no context_links
  const resolvedRows = db.prepare(
    `SELECT id, summary, evidence, context_links
     FROM nodes
     WHERE project = ? AND parent IS NOT NULL AND resolved = 1 AND evidence != '[]'`
  ).all(project) as Array<{ id: string; summary: string; evidence: string; context_links: string }>;

  for (const row of resolvedRows) {
    const evidence: Evidence[] = JSON.parse(row.evidence);
    const contextLinks: string[] = JSON.parse(row.context_links);

    // Skip auto-resolved nodes (they inherit quality from children)
    if (evidence.length === 1 && evidence[0].ref === "Auto-resolved: all children completed") {
      continue;
    }

    const hasGit = evidence.some(e => e.type === "git");
    const hasLinks = contextLinks.length > 0;

    if (!hasGit && !hasLinks) {
      issues.push({
        type: "weak_evidence",
        node_id: row.id,
        summary: row.summary,
        detail: "Resolved without git evidence or context_links — hard to trace what changed.",
      });
    }
  }

  // Also flag resolved nodes with zero evidence (legacy or edge case)
  const noEvidenceRows = db.prepare(
    `SELECT id, summary FROM nodes
     WHERE project = ? AND parent IS NOT NULL AND resolved = 1 AND evidence = '[]'`
  ).all(project) as Array<{ id: string; summary: string }>;

  for (const row of noEvidenceRows) {
    issues.push({
      type: "weak_evidence",
      node_id: row.id,
      summary: row.summary,
      detail: "Resolved with no evidence at all.",
    });
  }

  // 2. Stale claims — claimed > 24h ago, still unresolved
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const staleClaimRows = db.prepare(
    `SELECT id, summary, json_extract(properties, '$._claimed_by') as claimed_by,
            json_extract(properties, '$._claimed_at') as claimed_at
     FROM nodes
     WHERE project = ? AND parent IS NOT NULL AND resolved = 0
     AND json_extract(properties, '$._claimed_by') IS NOT NULL
     AND json_extract(properties, '$._claimed_at') < ?`
  ).all(project, oneDayAgo) as Array<{ id: string; summary: string; claimed_by: string; claimed_at: string }>;

  for (const row of staleClaimRows) {
    const claimedAge = Math.floor((now.getTime() - new Date(row.claimed_at).getTime()) / (60 * 60 * 1000));
    issues.push({
      type: "stale_claim",
      node_id: row.id,
      summary: row.summary,
      detail: `Claimed by ${row.claimed_by} ${claimedAge}h ago — resolve or unclaim.`,
    });
  }

  // 3. Orphan nodes — unresolved child of a resolved parent
  const orphanRows = db.prepare(
    `SELECT n.id, n.summary
     FROM nodes n
     JOIN nodes p ON p.id = n.parent
     WHERE n.project = ? AND n.resolved = 0 AND p.resolved = 1`
  ).all(project) as Array<{ id: string; summary: string }>;

  for (const row of orphanRows) {
    issues.push({
      type: "orphan",
      node_id: row.id,
      summary: row.summary,
      detail: "Unresolved but parent is resolved — data inconsistency.",
    });
  }

  // 4. Stale tasks — unresolved, not blocked, not claimed, not updated in 7+ days
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const staleRows = db.prepare(
    `SELECT id, summary, updated_at
     FROM nodes
     WHERE project = ? AND parent IS NOT NULL AND resolved = 0 AND blocked = 0
     AND json_extract(properties, '$._claimed_by') IS NULL
     AND updated_at < ?`
  ).all(project, sevenDaysAgo) as Array<{ id: string; summary: string; updated_at: string }>;

  for (const row of staleRows) {
    const staleDays = Math.floor((now.getTime() - new Date(row.updated_at).getTime()) / (24 * 60 * 60 * 1000));
    issues.push({
      type: "stale_task",
      node_id: row.id,
      summary: row.summary,
      detail: `Not updated in ${staleDays} days — still relevant?`,
    });
  }

  // Score: 100 minus weighted issue density
  const totalNonRoot = (db.prepare(
    "SELECT COUNT(*) as cnt FROM nodes WHERE project = ? AND parent IS NOT NULL"
  ).get(project) as { cnt: number }).cnt;

  let score = 100;
  if (totalNonRoot > 0) {
    const affectedNodes = new Set(issues.map(i => i.node_id)).size;
    score = Math.max(0, Math.round(100 * (1 - affectedNodes / totalNonRoot)));
  }

  return {
    issues,
    score,
    checked_at: now.toISOString(),
  };
}
