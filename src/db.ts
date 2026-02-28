import Database from "better-sqlite3";
import path from "path";
import { createHash } from "crypto";
import { homedir } from "os";
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "fs";

let db: Database.Database;
let dbPath: string;

// Shared DB path resolution — used by MCP server and UI server
export function resolveDbPath(): string {
  if (process.env.GRAPH_DB) return process.env.GRAPH_DB;
  const projectDir = path.resolve(".");
  const hash = createHash("sha256").update(projectDir).digest("hex").slice(0, 16);
  return path.join(homedir(), ".graph", "db", hash, "graph.db");
}

export function setDbPath(p: string): void {
  dbPath = p;
}

export function getDb(): Database.Database {
  if (!db) {
    const resolvedPath = dbPath ?? path.resolve("graph.db");
    db = new Database(resolvedPath);
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = FULL");
    db.pragma("foreign_keys = ON");
    migrate(db);

    // [sl:ypmZLicuvKKxfEDRkKpQG] Daily automatic backup
    if (resolvedPath !== ":memory:") {
      try {
        const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
        const existing = listBackups();
        if (!existing.some(b => b.filename.includes(today) && b.tag === "daily")) {
          backupDb("daily");
        }
      } catch {} // Don't let backup failure prevent DB access
    }
  }
  return db;
}

export function initDb(p?: string): Database.Database {
  // Close existing db if any (used by tests to reset state)
  if (db) {
    db.close();
    db = undefined!;
  }
  if (p) dbPath = p;
  return getDb();
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
      depth INTEGER NOT NULL DEFAULT 0,
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

    CREATE TABLE IF NOT EXISTS knowledge (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      key TEXT NOT NULL,
      content TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(project, key)
    );

    CREATE INDEX IF NOT EXISTS idx_knowledge_project ON knowledge(project);

    CREATE TABLE IF NOT EXISTS knowledge_log (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      key TEXT NOT NULL,
      action TEXT NOT NULL,
      old_content TEXT,
      new_content TEXT,
      agent TEXT NOT NULL,
      timestamp TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_knowledge_log_project ON knowledge_log(project);
    CREATE INDEX IF NOT EXISTS idx_knowledge_log_key ON knowledge_log(project, key);
  `);

  // Check which ALTER TABLE migrations are needed
  const cols = new Set(
    (db.prepare("SELECT name FROM pragma_table_info('nodes')").all() as Array<{ name: string }>)
      .map(c => c.name)
  );
  const needsAlter = !cols.has("depth") || !cols.has("discovery") || !cols.has("blocked") || !cols.has("plan");

  // [sl:ypmZLicuvKKxfEDRkKpQG] Pre-migration backup before schema changes
  if (needsAlter) {
    const hasData = (db.prepare("SELECT COUNT(*) as cnt FROM nodes").get() as { cnt: number }).cnt > 0;
    if (hasData) {
      try { backupDb("pre-migrate"); } catch {}
    }
  }

  if (!cols.has("depth")) {
    db.exec("ALTER TABLE nodes ADD COLUMN depth INTEGER NOT NULL DEFAULT 0");
    db.exec(`
      WITH RECURSIVE tree(id, depth) AS (
        SELECT id, 0 FROM nodes WHERE parent IS NULL
        UNION ALL
        SELECT n.id, t.depth + 1
        FROM nodes n JOIN tree t ON n.parent = t.id
      )
      UPDATE nodes SET depth = (SELECT depth FROM tree WHERE tree.id = nodes.id)
    `);
  }

  if (!cols.has("discovery")) {
    db.exec("ALTER TABLE nodes ADD COLUMN discovery TEXT DEFAULT NULL");
  }

  if (!cols.has("blocked")) {
    db.exec("ALTER TABLE nodes ADD COLUMN blocked INTEGER NOT NULL DEFAULT 0");
    db.exec("ALTER TABLE nodes ADD COLUMN blocked_reason TEXT DEFAULT NULL");
  }

  // [sl:t2sGegBC__5J8T-SIZe2B] Dedicated plan column
  if (!cols.has("plan")) {
    db.exec("ALTER TABLE nodes ADD COLUMN plan TEXT DEFAULT NULL");
  }

  // Index on blocked status (must come after blocked column migration)
  db.exec("CREATE INDEX IF NOT EXISTS idx_nodes_blocked ON nodes(project, blocked, resolved)");

  // [sl:w3IsGPGnfqalc4MEJxSKP] Add source_node to knowledge table — links entries to the task being worked on
  const knowledgeCols = new Set(
    (db.prepare("SELECT name FROM pragma_table_info('knowledge')").all() as Array<{ name: string }>)
      .map(c => c.name)
  );
  if (!knowledgeCols.has("source_node")) {
    db.exec("ALTER TABLE knowledge ADD COLUMN source_node TEXT DEFAULT NULL");
    db.exec("CREATE INDEX IF NOT EXISTS idx_knowledge_source_node ON knowledge(source_node)");
  }

  // [sl:1he9vXC_fddZDHHN1J_JG] Add category to knowledge entries
  if (!knowledgeCols.has("category")) {
    db.exec("ALTER TABLE knowledge ADD COLUMN category TEXT NOT NULL DEFAULT 'general'");
  }
}

export function checkpointDb(): void {
  if (db) {
    db.pragma("wal_checkpoint(TRUNCATE)");
  }
}

export function closeDb(): void {
  if (db) {
    checkpointDb();
    db.close();
  }
}

// [sl:ypmZLicuvKKxfEDRkKpQG] Built-in automatic DB backups

export interface BackupInfo {
  filename: string;
  size: number;
  created: string;
  tag: string;
}

function getBackupDir(): string {
  const resolved = dbPath ?? resolveDbPath();
  return path.join(path.dirname(resolved), "backups");
}

export function backupDb(tag: string = "manual"): string | null {
  const resolved = dbPath ?? resolveDbPath();
  if (resolved === ":memory:" || !existsSync(resolved)) return null;

  // Checkpoint WAL so backup file is self-contained
  if (db) {
    try { db.pragma("wal_checkpoint(TRUNCATE)"); } catch {}
  }

  const backupDir = getBackupDir();
  mkdirSync(backupDir, { recursive: true });

  const iso = new Date().toISOString();
  const ts = iso.slice(0, 10).replace(/-/g, "") + "-" + iso.slice(11, 19).replace(/:/g, "");
  const filename = `graph-${ts}-${tag}.db`;
  const dest = path.join(backupDir, filename);

  copyFileSync(resolved, dest);
  pruneBackups(10);

  return dest;
}

export function listBackups(): BackupInfo[] {
  const backupDir = getBackupDir();
  if (!existsSync(backupDir)) return [];

  return readdirSync(backupDir)
    .filter(f => f.startsWith("graph-") && f.endsWith(".db"))
    .sort()
    .reverse()
    .map(f => {
      const stat = statSync(path.join(backupDir, f));
      const tagMatch = f.match(/graph-\d{8}-\d{6}-(.+)\.db/);
      return {
        filename: f,
        size: stat.size,
        created: stat.mtime.toISOString(),
        tag: tagMatch?.[1] ?? "unknown",
      };
    });
}

export function restoreDb(target: string): string {
  const backups = listBackups();

  // Support numeric index (1 = most recent)
  let filename: string;
  const num = parseInt(target, 10);
  if (!isNaN(num) && num >= 1 && num <= backups.length) {
    filename = backups[num - 1].filename;
  } else {
    filename = target;
  }

  const backupDir = getBackupDir();
  const backupPath = path.join(backupDir, filename);
  if (!existsSync(backupPath)) {
    throw new Error(`Backup not found: ${filename}`);
  }

  const resolved = dbPath ?? resolveDbPath();

  // Close current DB if open
  if (db) {
    db.close();
    db = undefined!;
  }

  copyFileSync(backupPath, resolved);

  // Remove stale WAL/SHM files
  for (const ext of ["-wal", "-shm"]) {
    const p = resolved + ext;
    if (existsSync(p)) {
      try { unlinkSync(p); } catch {}
    }
  }

  return filename;
}

function pruneBackups(keep: number): void {
  const backupDir = getBackupDir();
  if (!existsSync(backupDir)) return;

  const files = readdirSync(backupDir)
    .filter(f => f.startsWith("graph-") && f.endsWith(".db"))
    .sort()
    .reverse();

  for (const file of files.slice(keep)) {
    try { unlinkSync(path.join(backupDir, file)); } catch {}
  }
}
