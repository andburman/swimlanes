import { getDb } from "../db.js";
import type { NodeRow } from "../types.js";

export interface QueryFilter {
  resolved?: boolean;
  properties?: Record<string, unknown>;
  text?: string;
  ancestor?: string;
  has_evidence_type?: string;
  is_leaf?: boolean;
  is_actionable?: boolean;
  is_blocked?: boolean;
  claimed_by?: string | null;
}

export interface QueryInput {
  project: string;
  filter?: QueryFilter;
  sort?: "readiness" | "depth" | "recent" | "created";
  limit?: number;
  cursor?: string;
}

export interface QueryResultNode {
  id: string;
  summary: string;
  resolved: boolean;
  state: unknown;
  parent: string | null;
  depth: number;
  properties: Record<string, unknown>;
}

export interface QueryResult {
  nodes: QueryResultNode[];
  total: number;
  next_cursor?: string;
}

// Get all descendant IDs of a node
function getDescendantIds(nodeId: string): string[] {
  const db = getDb();
  const ids: string[] = [];
  const stack = [nodeId];

  while (stack.length > 0) {
    const current = stack.pop()!;
    const children = db
      .prepare("SELECT id FROM nodes WHERE parent = ?")
      .all(current) as Array<{ id: string }>;

    for (const child of children) {
      ids.push(child.id);
      stack.push(child.id);
    }
  }

  return ids;
}

// Compute depth of a node (root = 0)
function computeDepth(nodeId: string): number {
  const db = getDb();
  let depth = 0;
  let current = db
    .prepare("SELECT parent FROM nodes WHERE id = ?")
    .get(nodeId) as { parent: string | null } | undefined;

  while (current?.parent) {
    depth++;
    current = db
      .prepare("SELECT parent FROM nodes WHERE id = ?")
      .get(current.parent) as { parent: string | null } | undefined;
  }

  return depth;
}

export function handleQuery(input: QueryInput): QueryResult {
  const db = getDb();
  const limit = Math.min(input.limit ?? 20, 100);
  const filter = input.filter;

  // Build WHERE clauses
  const conditions: string[] = ["n.project = ?"];
  const params: unknown[] = [input.project];

  if (filter?.resolved !== undefined) {
    conditions.push("n.resolved = ?");
    params.push(filter.resolved ? 1 : 0);
  }

  if (filter?.text) {
    conditions.push("n.summary LIKE ?");
    params.push(`%${filter.text}%`);
  }

  if (filter?.ancestor) {
    const descendantIds = getDescendantIds(filter.ancestor);
    if (descendantIds.length === 0) {
      return { nodes: [], total: 0 };
    }
    conditions.push(`n.id IN (${descendantIds.map(() => "?").join(",")})`);
    params.push(...descendantIds);
  }

  if (filter?.has_evidence_type) {
    conditions.push("n.evidence LIKE ?");
    params.push(`%"type":"${filter.has_evidence_type}"%`);
  }

  if (filter?.is_leaf) {
    conditions.push(
      "NOT EXISTS (SELECT 1 FROM nodes child WHERE child.parent = n.id AND child.resolved = 0)"
    );
  }

  if (filter?.is_actionable) {
    conditions.push("n.resolved = 0");
    conditions.push(
      "NOT EXISTS (SELECT 1 FROM nodes child WHERE child.parent = n.id AND child.resolved = 0)"
    );
    conditions.push(
      `NOT EXISTS (
        SELECT 1 FROM edges e
        JOIN nodes dep ON dep.id = e.to_node AND dep.resolved = 0
        WHERE e.from_node = n.id AND e.type = 'depends_on'
      )`
    );
  }

  if (filter?.is_blocked) {
    conditions.push("n.resolved = 0");
    conditions.push(
      `EXISTS (
        SELECT 1 FROM edges e
        JOIN nodes dep ON dep.id = e.to_node AND dep.resolved = 0
        WHERE e.from_node = n.id AND e.type = 'depends_on'
      )`
    );
  }

  if (filter?.properties) {
    for (const [key, value] of Object.entries(filter.properties)) {
      conditions.push("json_extract(n.properties, ?) = ?");
      params.push(`$.${key}`, value as string | number);
    }
  }

  if (filter?.claimed_by !== undefined) {
    if (filter.claimed_by === null) {
      conditions.push(
        "(json_extract(n.properties, '$._claimed_by') IS NULL)"
      );
    } else {
      conditions.push("json_extract(n.properties, '$._claimed_by') = ?");
      params.push(filter.claimed_by);
    }
  }

  // Cursor: use created_at + id for stable pagination
  if (input.cursor) {
    const [cursorTime, cursorId] = input.cursor.split("|");
    conditions.push("(n.created_at > ? OR (n.created_at = ? AND n.id > ?))");
    params.push(cursorTime, cursorTime, cursorId);
  }

  const whereClause = conditions.join(" AND ");

  // Sorting
  let orderBy: string;
  switch (input.sort) {
    case "depth":
      // Can't sort by computed depth in SQL easily, so sort by created and compute depth post-hoc
      orderBy = "n.created_at ASC, n.id ASC";
      break;
    case "recent":
      orderBy = "n.updated_at DESC, n.id ASC";
      break;
    case "created":
      orderBy = "n.created_at ASC, n.id ASC";
      break;
    case "readiness":
    default:
      orderBy = "n.updated_at ASC, n.id ASC";
      break;
  }

  // Count total
  const countQuery = `SELECT COUNT(*) as count FROM nodes n WHERE ${whereClause}`;
  const countParams = [...params];
  // Remove cursor params from count
  const total = (
    input.cursor
      ? db.prepare(`SELECT COUNT(*) as count FROM nodes n WHERE ${conditions.slice(0, -1).join(" AND ")}`).get(...params.slice(0, -3)) as { count: number }
      : db.prepare(countQuery).get(...countParams) as { count: number }
  ).count;

  // Fetch
  params.push(limit + 1);
  const query = `SELECT * FROM nodes n WHERE ${whereClause} ORDER BY ${orderBy} LIMIT ?`;
  const rows = db.prepare(query).all(...params) as NodeRow[];

  const hasMore = rows.length > limit;
  const slice = hasMore ? rows.slice(0, limit) : rows;

  const nodes: QueryResultNode[] = slice.map((row) => ({
    id: row.id,
    summary: row.summary,
    resolved: row.resolved === 1,
    state: row.state ? JSON.parse(row.state) : null,
    parent: row.parent,
    depth: computeDepth(row.id),
    properties: JSON.parse(row.properties),
  }));

  const result: QueryResult = { nodes, total };

  if (hasMore) {
    const last = slice[slice.length - 1];
    result.next_cursor = `${last.created_at}|${last.id}`;
  }

  return result;
}
