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

  if (existing) {
    db.prepare(
      "UPDATE knowledge SET content = ?, category = ?, source_node = COALESCE(?, source_node), updated_at = ? WHERE id = ?"
    ).run(content, category, sourceNode, now, existing.id);
    logKnowledgeMutation(project, key, "updated", existing.content, content, agent);
    return { key, action: "updated" as const };
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
      const result: { key: string; action: "created"; similar_keys: string[]; same_category_overlap?: string[] } = {
        key, action: "created", similar_keys: similar,
      };
      if (sameCategorySimilar.length > 0) {
        result.same_category_overlap = sameCategorySimilar;
      }
      return result;
    }
    return { key, action: "created" as const };
  }
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
