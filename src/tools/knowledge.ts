import { nanoid } from "nanoid";
import { getDb } from "../db.js";
import { getProjectRoot, listProjects } from "../nodes.js";
import { EngineError, requireString } from "../validate.js";

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

interface KnowledgeRow {
  id: string;
  project: string;
  key: string;
  content: string;
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
  source_node?: string;
}

export function handleKnowledgeWrite(input: KnowledgeWriteInput, agent: string) {
  const project = requireString(input.project, "project");
  const key = requireString(input.key, "key");
  const content = requireString(input.content, "content");

  requireProject(project);

  const db = getDb();
  const now = new Date().toISOString();

  const existing = db
    .prepare("SELECT id FROM knowledge WHERE project = ? AND key = ?")
    .get(project, key) as { id: string } | undefined;

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
      "UPDATE knowledge SET content = ?, source_node = COALESCE(?, source_node), updated_at = ? WHERE id = ?"
    ).run(content, sourceNode, now, existing.id);
    return { key, action: "updated" as const };
  } else {
    const id = nanoid();
    db.prepare(
      "INSERT INTO knowledge (id, project, key, content, source_node, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(id, project, key, content, sourceNode, agent, now, now);

    // Check for similar existing keys to surface potential overlaps
    const allKeys = db.prepare(
      "SELECT key FROM knowledge WHERE project = ? AND key != ? AND key NOT LIKE 'retro-%'"
    ).all(project, key) as Array<{ key: string }>;
    const similar = findSimilarKeys(key, allKeys.map(r => r.key));

    if (similar.length > 0) {
      return { key, action: "created" as const, similar_keys: similar };
    }
    return { key, action: "created" as const };
  }
}

// --- graph_knowledge_read ---

export interface KnowledgeReadInput {
  project: string;
  key?: string;
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
      source_node: row.source_node,
      updated_at: row.updated_at,
      created_by: row.created_by,
    };
  }

  // List all
  const rows = db
    .prepare("SELECT key, content, source_node, updated_at, created_by FROM knowledge WHERE project = ? ORDER BY updated_at DESC")
    .all(project) as Array<{ key: string; content: string; source_node: string | null; updated_at: string; created_by: string }>;

  return { entries: rows };
}

// --- graph_knowledge_delete ---

export interface KnowledgeDeleteInput {
  project: string;
  key: string;
}

export function handleKnowledgeDelete(input: KnowledgeDeleteInput) {
  const project = requireString(input.project, "project");
  const key = requireString(input.key, "key");

  requireProject(project);

  const db = getDb();
  const result = db
    .prepare("DELETE FROM knowledge WHERE project = ? AND key = ?")
    .run(project, key);

  if (result.changes === 0) {
    throw new EngineError("not_found", `Knowledge entry '${key}' not found in project '${project}'`);
  }

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
