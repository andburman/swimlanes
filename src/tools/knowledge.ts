import { nanoid } from "nanoid";
import { getDb } from "../db.js";
import { getProjectRoot } from "../nodes.js";
import { EngineError, requireString } from "../validate.js";

// [sl:4PrMkE09nf6ptz8LLR9rW] Knowledge tools — persistent project-level knowledge store

interface KnowledgeRow {
  id: string;
  project: string;
  key: string;
  content: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

// --- graph_knowledge_write ---

export interface KnowledgeWriteInput {
  project: string;
  key: string;
  content: string;
}

export function handleKnowledgeWrite(input: KnowledgeWriteInput, agent: string) {
  const project = requireString(input.project, "project");
  const key = requireString(input.key, "key");
  const content = requireString(input.content, "content");

  const root = getProjectRoot(project);
  if (!root) {
    throw new EngineError("not_found", `Project '${project}' not found`);
  }

  const db = getDb();
  const now = new Date().toISOString();

  const existing = db
    .prepare("SELECT id FROM knowledge WHERE project = ? AND key = ?")
    .get(project, key) as { id: string } | undefined;

  if (existing) {
    db.prepare(
      "UPDATE knowledge SET content = ?, updated_at = ? WHERE id = ?"
    ).run(content, now, existing.id);
    return { key, action: "updated" };
  } else {
    const id = nanoid();
    db.prepare(
      "INSERT INTO knowledge (id, project, key, content, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(id, project, key, content, agent, now, now);
    return { key, action: "created" };
  }
}

// --- graph_knowledge_read ---

export interface KnowledgeReadInput {
  project: string;
  key?: string;
}

export function handleKnowledgeRead(input: KnowledgeReadInput) {
  const project = requireString(input.project, "project");

  const root = getProjectRoot(project);
  if (!root) {
    throw new EngineError("not_found", `Project '${project}' not found`);
  }

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
      updated_at: row.updated_at,
      created_by: row.created_by,
    };
  }

  // List all
  const rows = db
    .prepare("SELECT key, content, updated_at, created_by FROM knowledge WHERE project = ? ORDER BY updated_at DESC")
    .all(project) as Array<{ key: string; content: string; updated_at: string; created_by: string }>;

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

  const root = getProjectRoot(project);
  if (!root) {
    throw new EngineError("not_found", `Project '${project}' not found`);
  }

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

  const root = getProjectRoot(project);
  if (!root) {
    throw new EngineError("not_found", `Project '${project}' not found`);
  }

  const db = getDb();
  const pattern = `%${query}%`;

  const rows = db
    .prepare(
      "SELECT key, content, updated_at, created_by FROM knowledge WHERE project = ? AND (key LIKE ? OR content LIKE ?) ORDER BY updated_at DESC"
    )
    .all(project, pattern, pattern) as Array<{ key: string; content: string; updated_at: string; created_by: string }>;

  return { entries: rows, query };
}
