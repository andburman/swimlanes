// [sl:P32JcxOYzCNAXEHWfbumy] graph_knowledge_audit — deep-clean analysis of knowledge entries

import { getDb } from "../db.js";
import { getProjectRoot, listProjects } from "../nodes.js";
import { requireString, EngineError } from "../validate.js";

export interface KnowledgeAuditInput {
  project: string;
}

interface SourceNodeInfo {
  id: string;
  summary: string;
  resolved: boolean;
}

// [sl:axlgmY3g9Dbl6BDLOX8-M] Token-optimized audit: flagged entries get full detail, healthy entries get minimal shape
export interface FlaggedEntry {
  key: string;
  content: string;
  category: string;
  updated_at: string;
  created_by: string;
  days_stale: number;
  flags: string[]; // e.g. ["stale", "overlap", "orphaned"]
  source_node: {
    status: "active" | "resolved" | "missing";
    id?: string;
    summary?: string;
  };
  similar_keys: string[];
}

export interface HealthyEntry {
  key: string;
  category: string;
  days_stale: number;
}

// [sl:FQWuyfNhEJEGsOXFZGOxP] Compact output: healthy as pipe-delimited text, flagged as JSON
export interface KnowledgeAuditResult {
  project: string;
  flagged: FlaggedEntry[];
  healthy: string; // pipe-delimited: "key|category|Nd" per line
  summary: {
    total: number;
    flagged: number;
    stale_30d: number;
    missing_source: number;
    potential_overlaps: number;
  };
  prompt: string;
}

/**
 * Compute similarity ratio between two strings (0-1).
 * Uses longest common substring ratio — cheap, no dependencies.
 */
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const short = a.length <= b.length ? a : b;
  const long = a.length <= b.length ? b : a;

  // If one is a prefix of the other, strong overlap signal
  if (long.startsWith(short) && short.length >= 3) return 0.8;

  // If one is a substring of the other, likely overlap
  if (long.includes(short) && short.length >= 3) return 0.7;

  // Longest common substring ratio
  let maxLen = 0;
  for (let i = 0; i < short.length; i++) {
    for (let j = i + 1; j <= short.length; j++) {
      const sub = short.slice(i, j);
      if (long.includes(sub) && sub.length > maxLen) {
        maxLen = sub.length;
      }
    }
  }
  return (2 * maxLen) / (a.length + b.length);
}

/**
 * Find keys that are suspiciously similar — potential duplicates or overlaps.
 * Uses normalized key comparison (strip common separators).
 */
function findSimilarKeys(keys: string[]): Map<string, string[]> {
  const result = new Map<string, string[]>();
  const THRESHOLD = 0.6;

  for (let i = 0; i < keys.length; i++) {
    const similar: string[] = [];
    for (let j = 0; j < keys.length; j++) {
      if (i === j) continue;
      // Normalize: lowercase, strip separators
      const a = keys[i].toLowerCase().replace(/[-_]/g, "");
      const b = keys[j].toLowerCase().replace(/[-_]/g, "");
      if (similarity(a, b) >= THRESHOLD) {
        similar.push(keys[j]);
      }
    }
    if (similar.length > 0) {
      result.set(keys[i], similar);
    }
  }
  return result;
}

export function handleKnowledgeAudit(input: KnowledgeAuditInput): KnowledgeAuditResult {
  const db = getDb();
  const project = requireString(input?.project, "project");

  const root = getProjectRoot(project);
  if (!root) {
    const available = listProjects().map(p => p.project).join(", ");
    throw new EngineError(
      "project_not_found",
      `Project not found: ${project}. Available projects: ${available || "(none)"}`
    );
  }

  // Get all non-retro knowledge entries
  const rows = db.prepare(
    "SELECT key, content, category, source_node, updated_at, created_by FROM knowledge WHERE project = ? AND key NOT LIKE 'retro-%' ORDER BY updated_at DESC"
  ).all(project) as Array<{
    key: string;
    content: string;
    category: string;
    source_node: string | null;
    updated_at: string;
    created_by: string;
  }>;

  if (rows.length === 0) {
    return {
      project,
      flagged: [],
      healthy: "",
      summary: { total: 0, flagged: 0, stale_30d: 0, missing_source: 0, potential_overlaps: 0 },
      prompt: "No knowledge entries to audit.",
    };
  }

  const now = new Date();

  // Batch-fetch source node info for all entries that have source_node
  const sourceNodeIds = rows
    .map(r => r.source_node)
    .filter((id): id is string => id !== null);

  const sourceNodes = new Map<string, SourceNodeInfo>();
  if (sourceNodeIds.length > 0) {
    const placeholders = sourceNodeIds.map(() => "?").join(",");
    const nodeRows = db.prepare(
      `SELECT id, summary, resolved FROM nodes WHERE id IN (${placeholders})`
    ).all(...sourceNodeIds) as Array<{ id: string; summary: string; resolved: number }>;
    for (const n of nodeRows) {
      sourceNodes.set(n.id, { id: n.id, summary: n.summary, resolved: n.resolved === 1 });
    }
  }

  // Compute key similarity
  const keys = rows.map(r => r.key);
  const similarKeys = findSimilarKeys(keys);

  // Build and classify entries — flagged get full detail, healthy get pipe-delimited text
  const STALE_THRESHOLD = 30;
  const flagged: FlaggedEntry[] = [];
  const healthyLines: string[] = [];

  for (const r of rows) {
    const updatedAt = new Date(r.updated_at);
    const daysSinceUpdate = Math.floor((now.getTime() - updatedAt.getTime()) / (1000 * 60 * 60 * 24));

    let sourceStatus: FlaggedEntry["source_node"];
    if (!r.source_node) {
      sourceStatus = { status: "missing" };
    } else {
      const node = sourceNodes.get(r.source_node);
      if (!node) {
        sourceStatus = { status: "missing", id: r.source_node };
      } else {
        sourceStatus = {
          status: node.resolved ? "resolved" : "active",
          id: node.id,
          summary: node.summary,
        };
      }
    }

    const similar = similarKeys.get(r.key) ?? [];
    const isStale = daysSinceUpdate >= STALE_THRESHOLD;
    const isOrphaned = sourceStatus.status === "missing";
    const hasOverlap = similar.length > 0;

    if (isStale || isOrphaned || hasOverlap) {
      const flags: string[] = [];
      if (isStale) flags.push("stale");
      if (hasOverlap) flags.push("overlap");
      if (isOrphaned) flags.push("orphaned");
      flagged.push({
        key: r.key,
        content: r.content,
        category: r.category,
        updated_at: r.updated_at,
        created_by: r.created_by,
        days_stale: daysSinceUpdate,
        flags,
        source_node: sourceStatus,
        similar_keys: similar,
      });
    } else {
      // [sl:FQWuyfNhEJEGsOXFZGOxP] Pipe-delimited: ~5 tokens vs ~30 for JSON
      healthyLines.push(`${r.key}|${r.category}|${daysSinceUpdate}d`);
    }
  }

  // Summary stats
  const overlaps = new Set<string>();
  for (const [key, similar] of similarKeys) {
    overlaps.add(key);
    for (const s of similar) overlaps.add(s);
  }

  const total = rows.length;
  const prompt = flagged.length === 0
    ? `All ${total} knowledge entries are healthy. No action needed.`
    : [
      `Audit found ${flagged.length} flagged entries out of ${total} total for project "${project}". Review each flagged entry:`,
      "",
      "1. **Contradictions** — do any entries contain conflicting information?",
      "2. **Stale content** — entries not updated in 30+ days may describe outdated architecture or decisions",
      "3. **Nomenclature drift** — same concepts referred to by different names across entries (check similar_keys for likely overlaps)",
      "4. **Orphaned entries** — source_node is 'missing' means the originating task was deleted; is the knowledge still relevant?",
      "5. **Coverage gaps** — is there important knowledge that should exist but doesn't?",
      "",
      "For each issue found, use graph_knowledge_write to update/consolidate, or graph_knowledge_delete to remove stale entries.",
      overlaps.size > 0 ? `\nPotential key overlaps detected: ${[...overlaps].join(", ")}. Check if these should be merged.` : "",
    ].filter(Boolean).join("\n");

  return {
    project,
    flagged,
    healthy: healthyLines.join("\n"),
    summary: {
      total,
      flagged: flagged.length,
      stale_30d: flagged.filter(e => e.flags.includes("stale")).length,
      missing_source: flagged.filter(e => e.flags.includes("orphaned")).length,
      potential_overlaps: overlaps.size,
    },
    prompt,
  };
}
