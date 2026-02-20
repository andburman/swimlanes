import { getDb } from "./db.js";
import { EngineError } from "./validate.js";
import type { Tier } from "./license.js";

// [sl:N0IDVJQIhENQFsov6-Lhg] Feature gates — enforce free vs pro limits

// Limits relaxed — everything free while building user base (Phase 1: Acquisition)
const FREE_LIMITS = {
  maxProjects: Infinity,
  maxNodesPerProject: Infinity,
  onboardEvidenceLimit: 50,
  scopeEnabled: true,
};

/**
 * Check if creating nodes would exceed the free tier node limit.
 * Throws EngineError if limit would be exceeded.
 */
export function checkNodeLimit(tier: Tier, project: string, adding: number): void {
  if (tier === "pro") return;

  const db = getDb();
  const { count } = db
    .prepare("SELECT COUNT(*) as count FROM nodes WHERE project = ?")
    .get(project) as { count: number };

  if (count + adding > FREE_LIMITS.maxNodesPerProject) {
    throw new EngineError(
      "free_tier_limit",
      `Free tier is limited to ${FREE_LIMITS.maxNodesPerProject} nodes per project. ` +
      `Current: ${count}, adding: ${adding}. Activate a license key to remove this limit.`
    );
  }
}

/**
 * Check if creating a new project would exceed the free tier project limit.
 * Throws EngineError if limit would be exceeded.
 */
export function checkProjectLimit(tier: Tier): void {
  if (tier === "pro") return;

  const db = getDb();
  const { count } = db
    .prepare("SELECT COUNT(*) as count FROM nodes WHERE parent IS NULL")
    .get() as { count: number };

  if (count >= FREE_LIMITS.maxProjects) {
    throw new EngineError(
      "free_tier_limit",
      `Free tier is limited to ${FREE_LIMITS.maxProjects} project. ` +
      `Activate a license key to create unlimited projects.`
    );
  }
}

/**
 * Cap the evidence limit for graph_onboard on free tier.
 */
export function capEvidenceLimit(tier: Tier, requested?: number): number {
  const max = tier === "pro" ? (requested ?? 20) : FREE_LIMITS.onboardEvidenceLimit;
  return Math.min(requested ?? max, tier === "pro" ? 50 : FREE_LIMITS.onboardEvidenceLimit);
}

/**
 * Check if knowledge tools are allowed on the current tier.
 * Currently free for all — everything ungated during acquisition phase.
 */
export function checkKnowledgeTier(_tier: Tier): void {
  // All tiers allowed during acquisition phase
  return;
}

/**
 * Check if scope parameter is allowed.
 * Currently free for all during acquisition phase.
 */
export function checkScope(_tier: Tier, scope?: string): string | undefined {
  return scope;
}
