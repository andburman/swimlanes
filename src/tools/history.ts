import { getEvents } from "../events.js";
import { getNodeOrThrow } from "../nodes.js";

export interface HistoryInput {
  node_id: string;
  limit?: number;
  cursor?: string;
}

export interface HistoryResult {
  events: Array<{
    timestamp: string;
    agent: string;
    action: string;
    changes: Array<{ field: string; before: unknown; after: unknown }>;
  }>;
  next_cursor?: string;
}

export function handleHistory(input: HistoryInput): HistoryResult {
  // Validate node exists
  getNodeOrThrow(input.node_id);

  const { events, next_cursor } = getEvents(
    input.node_id,
    input.limit ?? 20,
    input.cursor
  );

  const result: HistoryResult = {
    events: events.map((e) => ({
      timestamp: e.timestamp,
      agent: e.agent,
      action: e.action,
      changes: e.changes,
    })),
  };

  if (next_cursor) {
    result.next_cursor = next_cursor;
  }

  return result;
}
