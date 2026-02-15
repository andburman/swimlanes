import { nanoid } from "nanoid";
import { getDb } from "./db.js";
import type { FieldChange, Event } from "./types.js";

const INSERT_EVENT = `
  INSERT INTO events (id, node_id, agent, action, changes, timestamp)
  VALUES (?, ?, ?, ?, ?, ?)
`;

export function logEvent(
  nodeId: string,
  agent: string,
  action: string,
  changes: FieldChange[]
): Event {
  const db = getDb();
  const event: Event = {
    id: nanoid(),
    node_id: nodeId,
    agent,
    action,
    changes,
    timestamp: new Date().toISOString(),
  };

  db.prepare(INSERT_EVENT).run(
    event.id,
    event.node_id,
    event.agent,
    event.action,
    JSON.stringify(event.changes),
    event.timestamp
  );

  return event;
}

export function getEvents(
  nodeId: string,
  limit: number = 20,
  cursor?: string
): { events: Event[]; next_cursor: string | null } {
  const db = getDb();

  let query: string;
  let params: unknown[];

  if (cursor) {
    query = `
      SELECT * FROM events
      WHERE node_id = ? AND timestamp < ?
      ORDER BY timestamp DESC
      LIMIT ?
    `;
    params = [nodeId, cursor, limit + 1];
  } else {
    query = `
      SELECT * FROM events
      WHERE node_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `;
    params = [nodeId, limit + 1];
  }

  const rows = db.prepare(query).all(...params) as Array<{
    id: string;
    node_id: string;
    agent: string;
    action: string;
    changes: string;
    timestamp: string;
  }>;

  const hasMore = rows.length > limit;
  const slice = hasMore ? rows.slice(0, limit) : rows;

  const events: Event[] = slice.map((row) => ({
    id: row.id,
    node_id: row.node_id,
    agent: row.agent,
    action: row.action,
    changes: JSON.parse(row.changes),
    timestamp: row.timestamp,
  }));

  return {
    events,
    next_cursor: hasMore ? slice[slice.length - 1].timestamp : null,
  };
}
