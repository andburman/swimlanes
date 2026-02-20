import { getDb } from "../db.js";
import { createNode, getNode } from "../nodes.js";
import { addEdge } from "../edges.js";
import { requireArray, requireString, EngineError } from "../validate.js";

export interface PlanNodeInput {
  ref: string;
  parent_ref?: string;
  summary: string;
  context_links?: string[];
  depends_on?: string[];
  properties?: Record<string, unknown>;
}

export interface PlanInput {
  nodes: PlanNodeInput[];
}

export interface PlanResult {
  created: Array<{ ref: string; id: string }>;
}

export function handlePlan(input: PlanInput, agent: string): PlanResult {
  const db = getDb();
  const nodes = requireArray<PlanNodeInput>(input?.nodes, "nodes");

  // Validate each node has required fields
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    requireString(n.ref, `nodes[${i}].ref`);
    requireString(n.summary, `nodes[${i}].summary`);
  }

  // Ref -> real ID mapping
  const refMap = new Map<string, string>();
  const created: Array<{ ref: string; id: string }> = [];

  // Validate refs are unique
  const refs = new Set<string>();
  for (const node of nodes) {
    if (refs.has(node.ref)) {
      throw new EngineError("duplicate_ref", `Duplicate ref in batch: ${node.ref}`);
    }
    refs.add(node.ref);
  }

  // Run atomically
  const transaction = db.transaction(() => {
    // First pass: create all nodes
    for (const nodeInput of nodes) {
      // Resolve parent
      let parentId: string | undefined;
      if (nodeInput.parent_ref) {
        // Check if it's a batch ref or existing node ID
        parentId = refMap.get(nodeInput.parent_ref);
        if (!parentId) {
          // Try as existing node ID
          const existing = getNode(nodeInput.parent_ref);
          if (existing) {
            parentId = existing.id;
          } else {
            throw new EngineError(
              "invalid_parent_ref",
              `parent_ref "${nodeInput.parent_ref}" is neither a batch ref nor an existing node ID`
            );
          }
        }
      }

      // Determine project from parent or require first node to have a parent
      let project: string;
      if (parentId) {
        const parentNode = getNode(parentId)!;
        // [sl:m3_UNy-eICtHeHExfHwUH] Block decomposition when node has pending discovery
        if (parentNode.discovery === "pending") {
          throw new EngineError(
            "discovery_pending",
            `Cannot add children to "${parentNode.summary}" (${parentId}) — discovery is pending. Run: graph_update({ updates: [{ node_id: "${parentId}", discovery: "done" }] }) after completing discovery, then decompose.`
          );
        }
        project = parentNode.project;
      } else {
        // If no parent, the node must be a root. But we need a project.
        // Infer from first node that has a parent, or error.
        throw new EngineError(
          "missing_parent",
          `Node "${nodeInput.ref}" has no parent_ref. All planned nodes must have a parent (an existing node or a batch ref).`
        );
      }

      const node = createNode({
        project,
        parent: parentId,
        summary: nodeInput.summary,
        context_links: nodeInput.context_links,
        properties: nodeInput.properties,
        agent,
      });

      refMap.set(nodeInput.ref, node.id);
      created.push({ ref: nodeInput.ref, id: node.id });
    }

    // Second pass: create dependency edges
    for (const nodeInput of nodes) {
      if (!nodeInput.depends_on || nodeInput.depends_on.length === 0) continue;

      const fromId = refMap.get(nodeInput.ref)!;

      for (const dep of nodeInput.depends_on) {
        // Resolve dep: batch ref or existing node ID
        let toId = refMap.get(dep);
        if (!toId) {
          const existing = getNode(dep);
          if (existing) {
            toId = existing.id;
          } else {
            throw new EngineError(
              "invalid_depends_on",
              `depends_on "${dep}" in node "${nodeInput.ref}" is neither a batch ref nor an existing node ID`
            );
          }
        }

        const result = addEdge({
          from: fromId,
          to: toId,
          type: "depends_on",
          agent,
        });

        if (result.rejected) {
          throw new EngineError(
            "edge_rejected",
            `Dependency edge from "${nodeInput.ref}" to "${dep}" rejected: ${result.reason}`
          );
        }
      }
    }
  });

  transaction();

  return { created };
}
