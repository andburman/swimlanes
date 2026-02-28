import { nanoid } from "nanoid";
import { getDb } from "../db.js";
import { getProjectRoot, listProjects } from "../nodes.js";
import { EngineError, requireString } from "../validate.js";

function logKnowledgeMutation(
  project: string, key: string, action: string,
  oldContent: string | null, newContent: string | null, agent: string,
): void {
  const db = getDb();
  db.prepare(
    "INSERT INTO knowledge_log (id, project, key, action, old_content, new_content, agent, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(nanoid(), project, key, action, oldContent, newContent, agent, new Date().toISOString());
}

/** Check if two normalized keys are suspiciously similar */
function keySimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const short = a.length <= b.length ? a : b;
  const long = a.length <= b.length ? b : a;
  if (long.startsWith(short) && short.length >= 3) return 0.8;
  if (long.includes(short) && short.length >= 3) return 0.7;
  let maxLen = 0;
  for (let i = 0; i < short.length; i++) {
    for (let j = i + 1; j <= short.length; j++) {
      const sub = short.slice(i, j);
      if (long.includes(sub) && sub.length > maxLen) maxLen = sub.length;
    }
  }
  return (2 * maxLen) / (a.length + b.length);
}

function findSimilarKeys(targetKey: string, existingKeys: string[]): string[] {
  const normalized = targetKey.toLowerCase().replace(/[-_]/g, "");
  return existingKeys.filter(k => {
    const norm = k.toLowerCase().replace(/[-_]/g, "");
    return norm !== normalized && keySimilarity(normalized, norm) >= 0.6;
  });
}

function requireProject(project: string) {
  const root = getProjectRoot(project);
  if (!root) {
    const available = listProjects();
    const names = available.map((p) => p.project);
    const suffix = names.length > 0
      ? ` Available projects: ${names.join(", ")}`
      : " No projects exist yet.";
    throw new EngineError("project_not_found", `Project not found: ${project}.${suffix}`);
  }
  return root;
}

// [sl:4PrMkE09nf6ptz8LLR9rW] Knowledge tools — persistent project-level knowledge store

export const KNOWLEDGE_CATEGORIES = [
  "general", "architecture", "convention", "decision",
  "environment", "api-contract", "discovery",
] as const;
export type KnowledgeCategory = typeof KNOWLEDGE_CATEGORIES[number];
const CATEGORY_SET = new Set<string>(KNOWLEDGE_CATEGORIES);

interface KnowledgeRow {
  id: string;
  project: string;
  key: string;
  content: string;
  category: string;
  source_node: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

// --- graph_knowledge_write ---

export interface KnowledgeWriteInput {
  project: string;
  key: string;
  content: string;
  category?: KnowledgeCategory;
  source_node?: string;
}

// [sl:aeHtB8y-pLv-INh_w5N6k] ~2000 tokens ≈ 8000 chars threshold for size warning
const SIZE_WARNING_THRESHOLD = 8000;

export function handleKnowledgeWrite(input: KnowledgeWriteInput, agent: string) {
  const project = requireString(input.project, "project");
  const key = requireString(input.key, "key");
  const content = requireString(input.content, "content");

  // Validate category if provided
  const category = input.category ?? "general";
  if (!CATEGORY_SET.has(category)) {
    throw new EngineError(
      "invalid_category",
      `Invalid category "${category}". Must be one of: ${KNOWLEDGE_CATEGORIES.join(", ")}`
    );
  }

  requireProject(project);

  const db = getDb();
  const now = new Date().toISOString();

  const existing = db
    .prepare("SELECT id, content FROM knowledge WHERE project = ? AND key = ?")
    .get(project, key) as { id: string; content: string } | undefined;

  // [sl:KnkxY2V4h6OBwpV-z0E3L] Auto-detect source_node from agent's currently claimed node
  let sourceNode = input.source_node ?? null;
  if (!sourceNode) {
    const claimed = db.prepare(
      "SELECT id FROM nodes WHERE project = ? AND resolved = 0 AND json_extract(properties, '$._claimed_by') = ? LIMIT 1"
    ).get(project, agent) as { id: string } | undefined;
    if (claimed) sourceNode = claimed.id;
  }

  // Build result and append size warning if needed
  const sizeWarning = content.length > SIZE_WARNING_THRESHOLD
    ? `Content is ${content.length} chars (~${Math.round(content.length / 4)} tokens). Consider splitting into multiple entries for better token efficiency.`
    : undefined;

  if (existing) {
    db.prepare(
      "UPDATE knowledge SET content = ?, category = ?, source_node = COALESCE(?, source_node), updated_at = ? WHERE id = ?"
    ).run(content, category, sourceNode, now, existing.id);
    logKnowledgeMutation(project, key, "updated", existing.content, content, agent);
    // [sl:T5r3gfp3J40PQ2bUDFpak] Surface previous content so agents can verify they didn't lose information
    const previous_excerpt = existing.content.length > 200
      ? existing.content.slice(0, 200) + "..."
      : existing.content;
    const result: { key: string; action: "updated"; previous_excerpt: string; warning?: string } = {
      key, action: "updated", previous_excerpt,
    };
    if (sizeWarning) result.warning = sizeWarning;
    return result;
  } else {
    const id = nanoid();
    db.prepare(
      "INSERT INTO knowledge (id, project, key, content, category, source_node, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(id, project, key, content, category, sourceNode, agent, now, now);
    logKnowledgeMutation(project, key, "created", null, content, agent);

    // Check for similar existing keys to surface potential overlaps
    const allEntries = db.prepare(
      "SELECT key, category FROM knowledge WHERE project = ? AND key != ? AND key NOT LIKE 'retro-%'"
    ).all(project, key) as Array<{ key: string; category: string }>;
    const similar = findSimilarKeys(key, allEntries.map(r => r.key));

    // Flag same-category overlaps as stronger signal
    const sameCategorySimilar = similar.filter(k => {
      const entry = allEntries.find(e => e.key === k);
      return entry && entry.category === category;
    });

    if (similar.length > 0) {
      const result: { key: string; action: "created"; similar_keys: string[]; same_category_overlap?: string[]; warning?: string } = {
        key, action: "created", similar_keys: similar,
      };
      if (sameCategorySimilar.length > 0) {
        result.same_category_overlap = sameCategorySimilar;
      }
      if (sizeWarning) result.warning = sizeWarning;
      return result;
    }
    const result: { key: string; action: "created"; warning?: string } = { key, action: "created" };
    if (sizeWarning) result.warning = sizeWarning;
    return result;
  }
}

// --- graph_knowledge_write_batch --- [sl:EPpdOUXcpO5dSAQDNsfRX]

export interface KnowledgeWriteBatchInput {
  project: string;
  entries: Array<{
    key: string;
    content: string;
    category?: KnowledgeCategory;
    source_node?: string;
  }>;
}

// [sl:Ycf9WNY5KS4UzdHF30xie] Compact batch response: summary string + warnings only
export function handleKnowledgeWriteBatch(input: KnowledgeWriteBatchInput, agent: string) {
  const project = requireString(input.project, "project");
  if (!input.entries || !Array.isArray(input.entries) || input.entries.length === 0) {
    throw new EngineError("invalid_input", "entries must be a non-empty array");
  }

  requireProject(project);

  const db = getDb();
  let created = 0;
  let updated = 0;
  const warnings: string[] = [];

  const run = db.transaction(() => {
    for (const entry of input.entries) {
      const result = handleKnowledgeWrite(
        { project, key: entry.key, content: entry.content, category: entry.category, source_node: entry.source_node },
        agent,
      );
      if (result.action === "created") created++;
      else updated++;
      if (result.warning) warnings.push(`${entry.key}: ${result.warning}`);
      if ("similar_keys" in result && result.similar_keys) {
        warnings.push(`${entry.key}: similar to ${(result.similar_keys as string[]).join(", ")}`);
      }
    }
  });
  run();

  const total = created + updated;
  let summary = `wrote ${total}/${input.entries.length}`;
  const parts: string[] = [];
  if (created > 0) parts.push(`${created} created`);
  if (updated > 0) parts.push(`${updated} updated`);
  if (parts.length > 0) summary += ` (${parts.join(", ")})`;

  const result: { project: string; summary: string; warnings?: string[] } = { project, summary };
  if (warnings.length > 0) result.warnings = warnings;
  return result;
}

// --- graph_knowledge_read ---

export interface KnowledgeReadInput {
  project: string;
  key?: string;
}

function daysSince(dateStr: string): number {
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / (1000 * 60 * 60 * 24));
}

function lookupSourceNodeResolved(db: ReturnType<typeof getDb>, sourceNode: string | null): boolean | null {
  if (!sourceNode) return null;
  const row = db.prepare("SELECT resolved FROM nodes WHERE id = ?").get(sourceNode) as { resolved: number } | undefined;
  if (!row) return null; // node deleted
  return row.resolved === 1;
}

export function handleKnowledgeRead(input: KnowledgeReadInput) {
  const project = requireString(input.project, "project");

  requireProject(project);

  const db = getDb();

  if (input.key) {
    const row = db
      .prepare("SELECT * FROM knowledge WHERE project = ? AND key = ?")
      .get(project, input.key) as KnowledgeRow | undefined;

    if (!row) {
      throw new EngineError("not_found", `Knowledge entry '${input.key}' not found in project '${project}'`);
    }

    return {
      key: row.key,
      content: row.content,
      category: row.category,
      source_node: row.source_node,
      updated_at: row.updated_at,
      created_by: row.created_by,
      days_since_update: daysSince(row.updated_at),
      source_node_resolved: lookupSourceNodeResolved(db, row.source_node),
    };
  }

  // List all
  const rows = db
    .prepare("SELECT key, content, category, source_node, updated_at, created_by FROM knowledge WHERE project = ? ORDER BY updated_at DESC")
    .all(project) as Array<{ key: string; content: string; category: string; source_node: string | null; updated_at: string; created_by: string }>;

  // Batch-fetch source node resolution status
  const sourceIds = [...new Set(rows.map(r => r.source_node).filter((id): id is string => id !== null))];
  const resolvedMap = new Map<string, boolean>();
  if (sourceIds.length > 0) {
    const placeholders = sourceIds.map(() => "?").join(",");
    const nodeRows = db.prepare(
      `SELECT id, resolved FROM nodes WHERE id IN (${placeholders})`
    ).all(...sourceIds) as Array<{ id: string; resolved: number }>;
    for (const n of nodeRows) {
      resolvedMap.set(n.id, n.resolved === 1);
    }
  }

  const entries = rows.map(r => ({
    key: r.key,
    content: r.content,
    category: r.category,
    source_node: r.source_node,
    updated_at: r.updated_at,
    created_by: r.created_by,
    days_since_update: daysSince(r.updated_at),
    source_node_resolved: r.source_node ? (resolvedMap.get(r.source_node) ?? null) : null,
  }));

  return { entries };
}

// --- graph_knowledge_delete ---

export interface KnowledgeDeleteInput {
  project: string;
  key: string;
}

export function handleKnowledgeDelete(input: KnowledgeDeleteInput, agent: string) {
  const project = requireString(input.project, "project");
  const key = requireString(input.key, "key");

  requireProject(project);

  const db = getDb();

  // Fetch old content before deleting for mutation log
  const existing = db.prepare(
    "SELECT content FROM knowledge WHERE project = ? AND key = ?"
  ).get(project, key) as { content: string } | undefined;

  const result = db
    .prepare("DELETE FROM knowledge WHERE project = ? AND key = ?")
    .run(project, key);

  if (result.changes === 0) {
    throw new EngineError("not_found", `Knowledge entry '${key}' not found in project '${project}'`);
  }

  logKnowledgeMutation(project, key, "deleted", existing?.content ?? null, null, agent);

  return { key, action: "deleted" };
}

// --- graph_knowledge_search ---

export interface KnowledgeSearchInput {
  project: string;
  query: string;
}

export function handleKnowledgeSearch(input: KnowledgeSearchInput) {
  const project = requireString(input.project, "project");
  const query = requireString(input.query, "query");

  requireProject(project);

  const db = getDb();
  const pattern = `%${query}%`;

  const rows = db
    .prepare(
      "SELECT key, content, source_node, updated_at, created_by FROM knowledge WHERE project = ? AND (key LIKE ? OR content LIKE ?) ORDER BY updated_at DESC"
    )
    .all(project, pattern, pattern) as Array<{ key: string; content: string; source_node: string | null; updated_at: string; created_by: string }>;

  return { entries: rows, query };
}

// --- knowledge mutation log (for tests and downstream tools) ---

export interface KnowledgeLogEntry {
  key: string;
  action: string;
  old_content: string | null;
  new_content: string | null;
  agent: string;
  timestamp: string;
}

export function getKnowledgeLog(project: string, key?: string): KnowledgeLogEntry[] {
  const db = getDb();
  if (key) {
    return db.prepare(
      "SELECT key, action, old_content, new_content, agent, timestamp FROM knowledge_log WHERE project = ? AND key = ? ORDER BY timestamp DESC"
    ).all(project, key) as KnowledgeLogEntry[];
  }
  return db.prepare(
    "SELECT key, action, old_content, new_content, agent, timestamp FROM knowledge_log WHERE project = ? ORDER BY timestamp DESC"
  ).all(project) as KnowledgeLogEntry[];
}
