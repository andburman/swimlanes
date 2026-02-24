import { getNodeOrThrow, getChildren, getAncestors, getSubtreeProgress } from "../nodes.js";
import { getEdgesFrom, getEdgesTo } from "../edges.js";
import { getNode } from "../nodes.js";
import { getDb } from "../db.js";
import { requireString, optionalNumber } from "../validate.js";
import type { Node } from "../types.js";

export interface ContextInput {
  node_id: string;
  depth?: number;
}

interface NodeTree {
  id: string;
  summary: string;
  resolved: boolean;
  discovery: string | null;
  state: unknown;
  progress?: { resolved: number; total: number };
  children?: NodeTree[];
  child_count?: number;
}

export interface ContextResult {
  node: Node;
  ancestors: Array<{ id: string; summary: string; resolved: boolean }>;
  children: NodeTree;
  depends_on: Array<{ node: Node; satisfied: boolean }>;
  depended_by: Array<{ node: Node; satisfied: boolean }>;
  // [sl:IHJtkU6e8uSe9gRnUO6sa] Task-relevant knowledge surfacing
  relevant_knowledge?: Array<{ key: string; excerpt: string }>;
}

function buildNodeTree(nodeId: string, currentDepth: number, maxDepth: number): NodeTree {
  const node = getNodeOrThrow(nodeId);
  const children = getChildren(nodeId);

  const tree: NodeTree = {
    id: node.id,
    summary: node.summary,
    resolved: node.resolved,
    discovery: node.discovery,
    state: node.state,
  };

  if (children.length === 0) {
    return tree;
  }

  tree.progress = getSubtreeProgress(nodeId);

  if (currentDepth < maxDepth) {
    tree.children = children.map((child) =>
      buildNodeTree(child.id, currentDepth + 1, maxDepth)
    );
  } else {
    tree.child_count = children.length;
  }

  return tree;
}

export function handleContext(input: ContextInput): ContextResult {
  const nodeId = requireString(input?.node_id, "node_id");
  const depth = optionalNumber(input?.depth, "depth", 0, 10) ?? 2;
  const node = getNodeOrThrow(nodeId);
  const ancestors = getAncestors(nodeId);

  // Build children tree
  const children = buildNodeTree(nodeId, 0, depth);

  // Get dependency edges
  const depsOut = getEdgesFrom(nodeId, "depends_on");
  const depsIn = getEdgesTo(nodeId, "depends_on");

  const depends_on = depsOut.map((edge) => {
    const target = getNode(edge.to_node);
    return {
      node: target!,
      satisfied: target?.resolved ?? false,
    };
  });

  const depended_by = depsIn.map((edge) => {
    const source = getNode(edge.from_node);
    return {
      node: source!,
      satisfied: node.resolved,
    };
  });

  // [sl:IHJtkU6e8uSe9gRnUO6sa] Surface relevant knowledge linked to this node's subtree
  const db = getDb();
  const subtreeIds = [nodeId, ...ancestors.map(a => a.id)];
  // Include direct children
  const directChildren = getChildren(nodeId);
  subtreeIds.push(...directChildren.map(c => c.id));
  const placeholders = subtreeIds.map(() => "?").join(",");
  const knowledgeRows = db.prepare(
    `SELECT key, substr(content, 1, 80) as excerpt FROM knowledge
     WHERE project = ? AND source_node IN (${placeholders})
     ORDER BY updated_at DESC LIMIT 5`
  ).all(node.project, ...subtreeIds) as Array<{ key: string; excerpt: string }>;

  const result: ContextResult = { node, ancestors, children, depends_on, depended_by };
  if (knowledgeRows.length > 0) {
    result.relevant_knowledge = knowledgeRows;
  }
  return result;
}
