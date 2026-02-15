import { addEdge, removeEdge } from "../edges.js";

export interface ConnectEdgeInput {
  from: string;
  to: string;
  type: string;
  remove?: boolean;
}

export interface ConnectInput {
  edges: ConnectEdgeInput[];
}

export interface ConnectResult {
  applied: number;
  rejected?: Array<{ from: string; to: string; reason: string }>;
}

export function handleConnect(input: ConnectInput, agent: string): ConnectResult {
  let applied = 0;
  const rejected: Array<{ from: string; to: string; reason: string }> = [];

  for (const edge of input.edges) {
    if (edge.type === "parent") {
      rejected.push({
        from: edge.from,
        to: edge.to,
        reason: "parent_edges_not_allowed: use swimlanes_restructure to reparent",
      });
      continue;
    }

    if (edge.remove) {
      const removed = removeEdge(edge.from, edge.to, edge.type, agent);
      if (removed) {
        applied++;
      } else {
        rejected.push({
          from: edge.from,
          to: edge.to,
          reason: "edge_not_found",
        });
      }
    } else {
      const result = addEdge({
        from: edge.from,
        to: edge.to,
        type: edge.type,
        agent,
      });

      if (result.rejected) {
        rejected.push({
          from: edge.from,
          to: edge.to,
          reason: result.reason!,
        });
      } else {
        applied++;
      }
    }
  }

  const result: ConnectResult = { applied };
  if (rejected.length > 0) {
    result.rejected = rejected;
  }
  return result;
}
