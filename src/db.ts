import Database from "better-sqlite3";
import path from "path";

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    throw new Error("Database not initialized. Call initDb() first.");
  }
  return db;
}

export function initDb(dbPath?: string): Database.Database {
  const resolvedPath = dbPath ?? path.resolve("swimlanes.db");
  db = new Database(resolvedPath);

  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  migrate(db);
  return db;
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY,
      rev INTEGER NOT NULL DEFAULT 1,
      parent TEXT REFERENCES nodes(id),
      project TEXT NOT NULL,
      summary TEXT NOT NULL,
      resolved INTEGER NOT NULL DEFAULT 0,
      state TEXT,
      properties TEXT NOT NULL DEFAULT '{}',
      context_links TEXT NOT NULL DEFAULT '[]',
      evidence TEXT NOT NULL DEFAULT '[]',
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS edges (
      id TEXT PRIMARY KEY,
      from_node TEXT NOT NULL REFERENCES nodes(id),
      to_node TEXT NOT NULL REFERENCES nodes(id),
      type TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(from_node, to_node, type)
    );

    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      node_id TEXT NOT NULL REFERENCES nodes(id),
      agent TEXT NOT NULL,
      action TEXT NOT NULL,
      changes TEXT NOT NULL,
      timestamp TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_nodes_project ON nodes(project);
    CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent);
    CREATE INDEX IF NOT EXISTS idx_nodes_resolved ON nodes(project, resolved);
    CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_node);
    CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_node);
    CREATE INDEX IF NOT EXISTS idx_edges_type ON edges(from_node, type);
    CREATE INDEX IF NOT EXISTS idx_events_node ON events(node_id);
  `);
}

export function closeDb(): void {
  if (db) {
    db.close();
  }
}
