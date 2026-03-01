import { nanoid } from "nanoid";
import { getDb } from "./db.js";
import { logEvent } from "./events.js";
import { EngineError } from "./validate.js";
import type { Node, NodeRow, Evidence, FieldChange } from "./types.js";
import { computeDiscoveryPhase } from "./types.js";

// --- Row <-> Node conversion ---

function rowToNode(row: NodeRow): Node {
  const properties = JSON.parse(row.properties);
  return {
    id: row.id,
    rev: row.rev,
    parent: row.parent,
    project: row.project,
    summary: row.summary,
    resolved: row.resolved === 1,
    depth: row.depth,
    discovery: row.discovery ?? "done",  // legacy nodes with NULL treated as already-discovered
    discovery_phase: computeDiscoveryPhase(properties), // [sl:yd3p9m8fDraz_Hk88wa2r]
    blocked: row.blocked === 1,
    blocked_reason: row.blocked_reason ?? null,
    plan: row.plan ? JSON.parse(row.plan) : null,
    state: row.state ? JSON.parse(row.state) : null,
    properties,
    context_links: JSON.parse(row.context_links),
    evidence: JSON.parse(row.evidence),
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// --- Create ---

export interface CreateNodeInput {
  parent?: string;
  project: string;
  summary: string;
  discovery?: string | null;
  plan?: string[] | null;
  state?: unknown;
  properties?: Record<string, unknown>;
  context_links?: string[];
  agent: string;
  decision_context?: string; // [sl:M8jj8RzospuObjRJiDMRS]
}

export function createNode(input: CreateNodeInput): Node {
  const db = getDb();
  const now = new Date().toISOString();
  const id = nanoid();

  // [sl:yBBVr4wcgVfWA_w8U8hQo] Compute depth from parent
  let depth = 0;
  if (input.parent) {
    const parentRow = db.prepare("SELECT depth FROM nodes WHERE id = ?").get(input.parent) as { depth: number } | undefined;
    if (parentRow) depth = parentRow.depth + 1;
  }

  const properties = input.properties ?? {};
  const node: Node = {
    id,
    rev: 1,
    parent: input.parent ?? null,
    project: input.project,
    summary: input.summary,
    resolved: false,
    depth,
    discovery: input.discovery ?? "pending",
    discovery_phase: computeDiscoveryPhase(properties),
    blocked: false,
    blocked_reason: null,
    plan: input.plan ?? null,
    state: input.state ?? null,
    properties,
    context_links: input.context_links ?? [],
    evidence: [],
    created_by: input.agent,
    created_at: now,
    updated_at: now,
  };

  db.prepare(`
    INSERT INTO nodes (id, rev, parent, project, summary, resolved, depth, discovery, blocked, blocked_reason, plan, state, properties, context_links, evidence, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    node.id,
    node.rev,
    node.parent,
    node.project,
    node.summary,
    0,
    node.depth,
    node.discovery,
    0,
    null,
    node.plan ? JSON.stringify(node.plan) : null,
    node.state !== null ? JSON.stringify(node.state) : null,
    JSON.stringify(node.properties),
    JSON.stringify(node.context_links),
    JSON.stringify(node.evidence),
    node.created_by,
    node.created_at,
    node.updated_at
  );

  logEvent(node.id, input.agent, "created", [
    { field: "summary", before: null, after: node.summary },
  ], input.decision_context);

  return node;
}

// --- Read ---

export function getNode(id: string): Node | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM nodes WHERE id = ?").get(id) as
    | NodeRow
    | undefined;
  return row ? rowToNode(row) : null;
}

export function getNodeOrThrow(id: string): Node {
  const node = getNode(id);
  if (!node) {
    throw new EngineError("node_not_found", `Node not found: ${id}. Verify the ID is correct and the node hasn't been deleted.`);
  }
  return node;
}

export function getChildren(parentId: string): Node[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM nodes WHERE parent = ?")
    .all(parentId) as NodeRow[];
  return rows.map(rowToNode);
}

export function getAncestors(nodeId: string): Array<{ id: string; summary: string; resolved: boolean }> {
  const ancestors: Array<{ id: string; summary: string; resolved: boolean }> = [];
  let current = getNode(nodeId);

  while (current?.parent) {
    const parent = getNode(current.parent);
    if (!parent) break;
    ancestors.unshift({ id: parent.id, summary: parent.summary, resolved: parent.resolved });
    current = parent;
  }

  return ancestors;
}

export function getProjectRoot(project: string): Node | null {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM nodes WHERE project = ? AND parent IS NULL")
    .get(project) as NodeRow | undefined;
  return row ? rowToNode(row) : null;
}

export function listProjects(): Array<{
  project: string;
  id: string;
  summary: string;
  total: number;
  resolved: number;
  unresolved: number;
  updated_at: string;
}> {
  const db = getDb();

  const roots = db
    .prepare("SELECT * FROM nodes WHERE parent IS NULL")
    .all() as NodeRow[];

  return roots.map((root) => {
    const counts = db
      .prepare(
        `SELECT
          COUNT(*) as total,
          SUM(CASE WHEN resolved = 1 THEN 1 ELSE 0 END) as resolved
        FROM nodes WHERE project = ?`
      )
      .get(root.project) as { total: number; resolved: number };

    return {
      project: root.project,
      id: root.id,
      summary: root.summary,
      total: counts.total,
      resolved: counts.resolved,
      unresolved: counts.total - counts.resolved,
      updated_at: root.updated_at,
    };
  });
}

// --- Update ---

export interface UpdateNodeInput {
  node_id: string;
  agent: string;
  resolved?: boolean;
  discovery?: string | null;
  blocked?: boolean;
  blocked_reason?: string | null;
  plan?: string[] | null;
  state?: unknown;
  summary?: string;
  properties?: Record<string, unknown>;
  add_context_links?: string[];
  remove_context_links?: string[];
  add_evidence?: Array<{ type: string; ref: string }>;
  decision_context?: string; // [sl:M8jj8RzospuObjRJiDMRS]
}

export function updateNode(input: UpdateNodeInput): Node {
  const db = getDb();
  const node = getNodeOrThrow(input.node_id);
  const changes: FieldChange[] = [];
  const now = new Date().toISOString();

  let newResolved = node.resolved;
  let newDiscovery = node.discovery;
  let newBlocked = node.blocked;
  let newBlockedReason = node.blocked_reason;
  let newPlan = node.plan;
  let newState = node.state;
  let newSummary = node.summary;
  let newProperties = { ...node.properties };
  let newContextLinks = [...node.context_links];
  let newEvidence = [...node.evidence];

  // [sl:OZ0or-q5TserCEfWUeMVv] Require evidence when resolving
  if (input.resolved === true && !node.resolved) {
    const hasExistingEvidence = node.evidence.length > 0;
    const hasNewEvidence = input.add_evidence && input.add_evidence.length > 0;
    if (!hasExistingEvidence && !hasNewEvidence) {
      throw new EngineError(
        "evidence_required",
        `Cannot resolve node ${input.node_id} without evidence. Add at least one add_evidence entry (type: 'git', 'note', 'test', etc.) explaining what was done.`
      );
    }
  }

  if (input.resolved !== undefined && input.resolved !== node.resolved) {
    changes.push({ field: "resolved", before: node.resolved, after: input.resolved });
    newResolved = input.resolved;
  }

  if (input.discovery !== undefined && input.discovery !== node.discovery) {
    changes.push({ field: "discovery", before: node.discovery, after: input.discovery });
    newDiscovery = input.discovery;
  }

  // Require blocked_reason when blocking a node
  if (input.blocked === true && !node.blocked) {
    const reason = input.blocked_reason ?? node.blocked_reason;
    if (!reason) {
      throw new EngineError(
        "blocked_reason_required",
        `Cannot block node ${input.node_id} without a blocked_reason. Provide blocked_reason explaining why this node is blocked.`
      );
    }
  }

  if (input.blocked !== undefined && input.blocked !== node.blocked) {
    changes.push({ field: "blocked", before: node.blocked, after: input.blocked });
    newBlocked = input.blocked;
    // Clear blocked_reason when unblocking (unless explicitly set)
    if (!input.blocked && input.blocked_reason === undefined) {
      if (node.blocked_reason !== null) {
        changes.push({ field: "blocked_reason", before: node.blocked_reason, after: null });
      }
      newBlockedReason = null;
    }
  }

  if (input.blocked_reason !== undefined && input.blocked_reason !== node.blocked_reason) {
    changes.push({ field: "blocked_reason", before: node.blocked_reason, after: input.blocked_reason });
    newBlockedReason = input.blocked_reason;
  }

  if (input.plan !== undefined) {
    changes.push({ field: "plan", before: node.plan, after: input.plan });
    newPlan = input.plan;
  }

  if (input.state !== undefined) {
    changes.push({ field: "state", before: node.state, after: input.state });
    newState = input.state;
  }

  if (input.summary !== undefined && input.summary !== node.summary) {
    changes.push({ field: "summary", before: node.summary, after: input.summary });
    newSummary = input.summary;
  }

  if (input.properties) {
    for (const [key, value] of Object.entries(input.properties)) {
      if (value === null) {
        if (key in newProperties) {
          changes.push({ field: `properties.${key}`, before: newProperties[key], after: null });
          delete newProperties[key];
        }
      } else {
        changes.push({ field: `properties.${key}`, before: newProperties[key] ?? null, after: value });
        newProperties[key] = value;
      }
    }
  }

  if (input.add_context_links) {
    for (const link of input.add_context_links) {
      if (!newContextLinks.includes(link)) {
        newContextLinks.push(link);
        changes.push({ field: "context_links", before: null, after: link });
      }
    }
  }

  if (input.remove_context_links) {
    for (const link of input.remove_context_links) {
      const idx = newContextLinks.indexOf(link);
      if (idx !== -1) {
        newContextLinks.splice(idx, 1);
        changes.push({ field: "context_links", before: link, after: null });
      }
    }
  }

  if (input.add_evidence) {
    for (const ev of input.add_evidence) {
      const evidence: Evidence = {
        type: ev.type,
        ref: ev.ref,
        agent: input.agent,
        timestamp: now,
      };
      newEvidence.push(evidence);
      changes.push({ field: "evidence", before: null, after: evidence });
    }
  }

  if (changes.length === 0) {
    return node;
  }

  const newRev = node.rev + 1;

  db.prepare(`
    UPDATE nodes SET
      rev = ?,
      resolved = ?,
      discovery = ?,
      blocked = ?,
      blocked_reason = ?,
      plan = ?,
      state = ?,
      summary = ?,
      properties = ?,
      context_links = ?,
      evidence = ?,
      updated_at = ?
    WHERE id = ?
  `).run(
    newRev,
    newResolved ? 1 : 0,
    newDiscovery,
    newBlocked ? 1 : 0,
    newBlockedReason,
    newPlan ? JSON.stringify(newPlan) : null,
    newState !== null ? JSON.stringify(newState) : null,
    newSummary,
    JSON.stringify(newProperties),
    JSON.stringify(newContextLinks),
    JSON.stringify(newEvidence),
    now,
    input.node_id
  );

  const action = input.resolved === true ? "resolved" : "updated";
  logEvent(input.node_id, input.agent, action, changes, input.decision_context);

  return getNodeOrThrow(input.node_id);
}

// --- Progress ---

export function getSubtreeProgress(nodeId: string): { resolved: number; total: number } {
  const db = getDb();
  const row = db.prepare(
    `WITH RECURSIVE descendants(id) AS (
      SELECT id FROM nodes WHERE id = ?
      UNION ALL
      SELECT n.id FROM nodes n JOIN descendants d ON n.parent = d.id
    )
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN n.resolved = 1 THEN 1 ELSE 0 END) as resolved
    FROM descendants d JOIN nodes n ON n.id = d.id`
  ).get(nodeId) as { total: number; resolved: number };
  return { resolved: row.resolved, total: row.total };
}

// --- Query helpers ---

export function getProjectSummary(project: string): {
  total: number;
  resolved: number;
  unresolved: number;
  blocked: number;
  actionable: number;
} {
  const db = getDb();

  const counts = db
    .prepare(
      `SELECT
        COUNT(*) as total,
        SUM(CASE WHEN resolved = 1 THEN 1 ELSE 0 END) as resolved
      FROM nodes WHERE project = ?`
    )
    .get(project) as { total: number; resolved: number };

  // Blocked: unresolved nodes that are manually blocked OR have unresolved dependencies
  const blocked = db
    .prepare(
      `SELECT COUNT(DISTINCT id) as count FROM (
         SELECT n.id FROM nodes n
         WHERE n.project = ? AND n.resolved = 0 AND n.blocked = 1
         UNION
         SELECT n.id FROM nodes n
         JOIN edges e ON e.from_node = n.id AND e.type = 'depends_on'
         JOIN nodes dep ON dep.id = e.to_node AND dep.resolved = 0
         WHERE n.project = ? AND n.resolved = 0
       )`
    )
    .get(project, project) as { count: number };

  // Actionable: unresolved leaves (no unresolved children) with all deps resolved and not manually blocked
  // [sl:sUJf8RKzDV8-XerhknAfg] Exclude root node — must match onboard's actionable array filter
  const actionable = db
    .prepare(
      `SELECT COUNT(*) as count FROM nodes n
       WHERE n.project = ? AND n.parent IS NOT NULL AND n.resolved = 0 AND n.blocked = 0
       AND NOT EXISTS (
         SELECT 1 FROM nodes child WHERE child.parent = n.id AND child.resolved = 0
       )
       AND NOT EXISTS (
         SELECT 1 FROM edges e
         JOIN nodes dep ON dep.id = e.to_node AND dep.resolved = 0
         WHERE e.from_node = n.id AND e.type = 'depends_on'
       )`
    )
    .get(project) as { count: number };

  return {
    total: counts.total,
    resolved: counts.resolved,
    unresolved: counts.total - counts.resolved,
    blocked: blocked.count,
    actionable: actionable.count,
  };
}
