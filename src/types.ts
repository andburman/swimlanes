export type DiscoveryPhase = "raw" | "decomposed" | "in_review" | "deciding" | "ready";

export interface Node {
  id: string;
  rev: number;
  parent: string | null;
  project: string;
  summary: string;
  resolved: boolean;
  depth: number;
  discovery: string | null;
  discovery_phase: DiscoveryPhase;
  blocked: boolean;
  blocked_reason: string | null;
  plan: string[] | null;
  state: unknown;
  properties: Record<string, unknown>;
  context_links: string[];
  evidence: Evidence[];
  created_by: string;
  created_at: string;
  updated_at: string;
}

// [sl:yd3p9m8fDraz_Hk88wa2r] Compute discovery phase from artifact state
export function computeDiscoveryPhase(properties: Record<string, unknown>): DiscoveryPhase {
  const artifacts = properties?.discovery_artifacts as {
    assumptions?: Array<{ status: string }>;
    decisions?: Array<{ status: string }>;
    edge_cases?: Array<{ scope: string | null }>;
    definition_of_done?: Array<{ met: boolean | null }>;
  } | undefined;

  if (!artifacts) return "raw";

  const assumptions = artifacts.assumptions || [];
  const decisions = artifacts.decisions || [];
  const edgeCases = artifacts.edge_cases || [];
  const dod = artifacts.definition_of_done || [];

  // Deciding takes precedence — open decisions mean human is the blocker
  if (decisions.some(d => d.status === "open")) return "deciding";

  // Any untested assumptions → decomposed
  if (assumptions.length > 0 && assumptions.some(a => a.status === "untested")) return "decomposed";

  // All assumptions tested but edge cases unscoped or DoD unconfirmed → in_review
  const unscopedEdges = edgeCases.some(e => e.scope === null);
  const unmetDod = dod.length === 0 || dod.some(d => d.met === null);
  if (assumptions.length > 0 && (unscopedEdges || unmetDod)) return "in_review";

  // Everything resolved
  if (assumptions.length > 0) return "ready";

  return "raw";
}

// [sl:_K34zI3STM3EMvL6pmeRG] Compute blind spot signals for confidence challenging
export function computeChallenges(node: Node): string[] {
  const challenges: string[] = [];
  const phase = node.discovery_phase;
  const artifacts = node.properties?.discovery_artifacts as {
    assumptions?: Array<{ status: string }>;
    decisions?: Array<{ status: string }>;
    edge_cases?: Array<{ scope: string | null }>;
    definition_of_done?: Array<{ met: boolean | null }>;
  } | undefined;

  if (!artifacts || phase === "raw") {
    challenges.push("No discovery artifacts yet — assumptions untested");
    return challenges;
  }

  const assumptions = artifacts.assumptions || [];
  const decisions = artifacts.decisions || [];
  const edgeCases = artifacts.edge_cases || [];
  const dod = artifacts.definition_of_done || [];

  if (assumptions.length === 0) {
    challenges.push("No assumptions declared — agent may be overconfident");
  }
  if (edgeCases.length === 0) {
    challenges.push("No edge cases explored");
  }
  if (dod.length === 0) {
    challenges.push("No definition of done criteria");
  }
  if (decisions.length === 0 && assumptions.length > 0) {
    challenges.push("No decisions recorded — may have skipped discovery");
  }

  const rejectedRate = assumptions.length > 0
    ? assumptions.filter(a => a.status === "rejected").length / assumptions.length
    : 0;
  if (rejectedRate > 0.4) {
    challenges.push(`High rejection rate (${Math.round(rejectedRate * 100)}%) — initial understanding was off`);
  }

  const lastActivity = new Date(node.updated_at).getTime();
  const daysSinceActivity = (Date.now() - lastActivity) / (1000 * 60 * 60 * 24);
  if (daysSinceActivity > 3) {
    challenges.push(`Last activity ${Math.round(daysSinceActivity)} days ago — context may have drifted`);
  }

  return challenges;
}

export interface Evidence {
  type: string;
  ref: string;
  agent: string;
  timestamp: string;
}

export interface Edge {
  id: string;
  from_node: string;
  to_node: string;
  type: string;
  created_at: string;
}

export interface Event {
  id: string;
  node_id: string;
  agent: string;
  action: string;
  changes: FieldChange[];
  timestamp: string;
  decision_context?: string; // [sl:M8jj8RzospuObjRJiDMRS]
}

export interface FieldChange {
  field: string;
  before: unknown;
  after: unknown;
}

export interface NodeRow {
  id: string;
  rev: number;
  parent: string | null;
  project: string;
  summary: string;
  resolved: number;
  depth: number;
  discovery: string | null;
  blocked: number;
  blocked_reason: string | null;
  plan: string | null;
  state: string | null;
  properties: string;
  context_links: string;
  evidence: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}
