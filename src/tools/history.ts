import { getEvents } from "../events.js";
import { getNodeOrThrow } from "../nodes.js";
import { requireString, optionalNumber, optionalString } from "../validate.js";

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
    decision_context?: string; // [sl:M8jj8RzospuObjRJiDMRS]
  }>;
  next_cursor?: string;
}

export function handleHistory(input: HistoryInput): HistoryResult {
  const nodeId = requireString(input?.node_id, "node_id");
  const limit = optionalNumber(input?.limit, "limit", 1, 100) ?? 20;
  const cursor = optionalString(input?.cursor, "cursor");

  getNodeOrThrow(nodeId);

  const { events, next_cursor } = getEvents(nodeId, limit, cursor);

  const result: HistoryResult = {
    events: events.map((e) => {
      const ev: HistoryResult["events"][number] = {
        timestamp: e.timestamp,
        agent: e.agent,
        action: e.action,
        changes: e.changes,
      };
      if (e.decision_context) ev.decision_context = e.decision_context;
      return ev;
    }),
  };

  if (next_cursor) {
    result.next_cursor = next_cursor;
  }

  return result;
}
