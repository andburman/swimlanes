// [sl:v4-uJ6Q28R-pGRPrGOav6] Continuity confidence signal — graph quality metric

import { getDb } from "./db.js";

export interface ContinuityConfidence {
  confidence: "high" | "medium" | "low";
  score: number; // 0-100
  reasons: string[];
}

interface ProjectStats {
  resolvedCount: number;
  resolvedWithEvidence: number;
  lastActivity: string | null;
  knowledgeCount: number;
  staleBlockedCount: number;
  totalNonRoot: number;
}

function getProjectStats(project: string): ProjectStats {
  const db = getDb();

  // Count resolved tasks (exclude root)
  const resolved = db.prepare(
    "SELECT COUNT(*) as cnt FROM nodes WHERE project = ? AND parent IS NOT NULL AND resolved = 1"
  ).get(project) as { cnt: number };

  // Count resolved tasks with evidence
  const withEvidence = db.prepare(
    "SELECT COUNT(*) as cnt FROM nodes WHERE project = ? AND parent IS NOT NULL AND resolved = 1 AND evidence != '[]'"
  ).get(project) as { cnt: number };

  // Last activity
  const lastAct = db.prepare(
    "SELECT MAX(updated_at) as last FROM nodes WHERE project = ?"
  ).get(project) as { last: string | null };

  // Knowledge count
  const knowledge = db.prepare(
    "SELECT COUNT(*) as cnt FROM knowledge WHERE project = ?"
  ).get(project) as { cnt: number };

  // Stale blocked items (blocked for 7+ days with no update)
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const staleBlocked = db.prepare(
    "SELECT COUNT(*) as cnt FROM nodes WHERE project = ? AND blocked = 1 AND updated_at < ?"
  ).get(project, sevenDaysAgo) as { cnt: number };

  // Total non-root nodes
  const total = db.prepare(
    "SELECT COUNT(*) as cnt FROM nodes WHERE project = ? AND parent IS NOT NULL"
  ).get(project) as { cnt: number };

  return {
    resolvedCount: resolved.cnt,
    resolvedWithEvidence: withEvidence.cnt,
    lastActivity: lastAct.last,
    knowledgeCount: knowledge.cnt,
    staleBlockedCount: staleBlocked.cnt,
    totalNonRoot: total.cnt,
  };
}

export function computeContinuityConfidence(project: string): ContinuityConfidence {
  const stats = getProjectStats(project);
  const reasons: string[] = [];
  let score = 100;

  // 1. Evidence coverage (biggest factor — 40 points)
  if (stats.resolvedCount > 0) {
    const coverage = stats.resolvedWithEvidence / stats.resolvedCount;
    const missing = stats.resolvedCount - stats.resolvedWithEvidence;
    if (coverage < 0.5) {
      score -= 40;
      reasons.push(`${missing} of ${stats.resolvedCount} resolved tasks have no evidence`);
    } else if (coverage < 0.8) {
      score -= 20;
      reasons.push(`${missing} of ${stats.resolvedCount} resolved tasks have no evidence`);
    } else if (coverage < 1.0) {
      score -= 10;
      reasons.push(`${missing} resolved task(s) missing evidence`);
    }
  }

  // 2. Staleness (25 points)
  if (stats.lastActivity) {
    const ageMs = Date.now() - new Date(stats.lastActivity).getTime();
    const ageDays = ageMs / (24 * 60 * 60 * 1000);
    if (ageDays > 14) {
      score -= 25;
      reasons.push(`No activity for ${Math.floor(ageDays)} days`);
    } else if (ageDays > 7) {
      score -= 15;
      reasons.push(`No activity for ${Math.floor(ageDays)} days`);
    } else if (ageDays > 3) {
      score -= 5;
      reasons.push(`Last activity ${Math.floor(ageDays)} days ago`);
    }
  }

  // 3. Knowledge (15 points) — only flag on mature projects (5+ resolved tasks)
  if (stats.resolvedCount >= 5 && stats.knowledgeCount === 0) {
    score -= 15;
    reasons.push("No knowledge entries on a project with 5+ resolved tasks");
  }

  // 4. Stale blockers (10 points)
  if (stats.staleBlockedCount > 0) {
    score -= 10;
    reasons.push(`${stats.staleBlockedCount} blocked item(s) not updated in 7+ days`);
  }

  // 5. Empty project — no tasks yet (10 points)
  if (stats.totalNonRoot === 0) {
    score -= 10;
    reasons.push("Project has no tasks yet");
  }

  // Clamp
  score = Math.max(0, Math.min(100, score));

  // Map to band
  let confidence: ContinuityConfidence["confidence"];
  if (score >= 70) {
    confidence = "high";
  } else if (score >= 40) {
    confidence = "medium";
  } else {
    confidence = "low";
  }

  return { confidence, score, reasons };
}
