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
    healthy: number; // [sl:2g13PcLtVSApmJk2_XL6c]
    flagged: number;
    stale_30d: number;
    missing_source: number;
    potential_overlaps: number;
  };
  prompt: string;
}

// [sl:j-sIf9idlYs26FzBNmE58] Content-based overlap detection — same category + >60% word overlap
function extractContentWords(content: string): Set<string> {
  const stopWords = new Set(["the", "a", "an", "and", "or", "for", "to", "in", "on", "of", "is", "it", "as", "at", "by", "with", "from", "that", "this", "be", "are", "was", "were", "has", "have", "had", "do", "does", "did", "not", "no", "but", "if", "up", "out", "all"]);
  return new Set(
    content.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/)
      .filter(w => w.length > 2 && !stopWords.has(w))
  );
}

function contentWordOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const shared = [...a].filter(w => b.has(w)).length;
  const minSize = Math.min(a.size, b.size);
  return shared / minSize;
}

/**
 * Find entries with overlapping content — same category + >60% word overlap.
 */
function findOverlaps(entries: Array<{ key: string; content: string; category: string }>): Map<string, string[]> {
  const result = new Map<string, string[]>();
  const THRESHOLD = 0.6;

  // Pre-compute word sets
  const wordSets = entries.map(e => ({ key: e.key, category: e.category, words: extractContentWords(e.content) }));

  for (let i = 0; i < wordSets.length; i++) {
    const similar: string[] = [];
    for (let j = 0; j < wordSets.length; j++) {
      if (i === j) continue;
      // Only compare within same category
      if (wordSets[i].category !== wordSets[j].category) continue;
      if (contentWordOverlap(wordSets[i].words, wordSets[j].words) >= THRESHOLD) {
        similar.push(wordSets[j].key);
      }
    }
    if (similar.length > 0) {
      result.set(wordSets[i].key, similar);
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
      summary: { total: 0, healthy: 0, flagged: 0, stale_30d: 0, missing_source: 0, potential_overlaps: 0 },
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

  // [sl:j-sIf9idlYs26FzBNmE58] Content-based overlap detection within same category
  const overlaps = findOverlaps(rows.map(r => ({ key: r.key, content: r.content, category: r.category })));

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

    const similar = overlaps.get(r.key) ?? [];
    const isStale = daysSinceUpdate >= STALE_THRESHOLD;
    // [sl:wwVQzbT6SNP_e4rAmKnSm] Only flag orphaned when source_node is truly missing (deleted/absent), not when resolved
    const isOrphaned = sourceStatus.status === "missing" && r.source_node !== null;
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
  const overlapKeys = new Set<string>();
  for (const [key, similar] of overlaps) {
    overlapKeys.add(key);
    for (const s of similar) overlapKeys.add(s);
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
      overlapKeys.size > 0 ? `\nPotential content overlaps detected: ${[...overlapKeys].join(", ")}. Check if these should be merged.` : "",
    ].filter(Boolean).join("\n");

  return {
    project,
    flagged,
    healthy: healthyLines.join("\n"),
    summary: {
      total,
      healthy: healthyLines.length,
      flagged: flagged.length,
      stale_30d: flagged.filter(e => e.flags.includes("stale")).length,
      missing_source: flagged.filter(e => e.flags.includes("orphaned")).length,
      potential_overlaps: overlapKeys.size,
    },
    prompt,
  };
}
