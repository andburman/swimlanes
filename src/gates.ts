import { getDb } from "./db.js";
import { EngineError } from "./validate.js";
import type { Tier } from "./license.js";

// [sl:N0IDVJQIhENQFsov6-Lhg] Feature gates — enforce free vs pro limits

const FREE_LIMITS = {
  maxProjects: 1,
  maxNodesPerProject: 50,
  onboardEvidenceLimit: 5,
  scopeEnabled: false,
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
 * Throws EngineError on free tier.
 */
export function checkKnowledgeTier(tier: Tier): void {
  if (tier === "pro") return;

  throw new EngineError(
    "free_tier_limit",
    "Knowledge tools are a pro feature. Activate a license key to use graph_knowledge_write, graph_knowledge_read, graph_knowledge_search, and graph_knowledge_delete."
  );
}

/**
 * Check if scope parameter is allowed on free tier.
 * Returns undefined (stripped) if not allowed.
 */
export function checkScope(tier: Tier, scope?: string): string | undefined {
  if (tier === "pro") return scope;
  return undefined; // silently ignore scope on free tier
}
