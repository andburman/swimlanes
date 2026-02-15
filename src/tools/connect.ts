import { addEdge, removeEdge } from "../edges.js";
import { requireArray, requireString } from "../validate.js";

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
  const edges = requireArray<ConnectEdgeInput>(input?.edges, "edges");

  for (let i = 0; i < edges.length; i++) {
    requireString(edges[i].from, `edges[${i}].from`);
    requireString(edges[i].to, `edges[${i}].to`);
    requireString(edges[i].type, `edges[${i}].type`);
  }

  let applied = 0;
  const rejected: Array<{ from: string; to: string; reason: string }> = [];

  for (const edge of edges) {
    if (edge.type === "parent") {
      rejected.push({
        from: edge.from,
        to: edge.to,
        reason: "parent_edges_not_allowed: use graph_restructure to reparent",
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
