import { createNode, getProjectRoot, listProjects, getProjectSummary } from "../nodes.js";
import type { Node } from "../types.js";

export interface OpenInput {
  project?: string;
  goal?: string;
}

export type OpenResult =
  | {
      projects: Array<{
        id: string;
        summary: string;
        total: number;
        resolved: number;
        unresolved: number;
        updated_at: string;
      }>;
    }
  | {
      root: Node;
      summary: {
        total: number;
        resolved: number;
        unresolved: number;
        blocked: number;
        actionable: number;
      };
    };

export function handleOpen(input: OpenInput, agent: string): OpenResult {
  if (!input.project) {
    return { projects: listProjects() };
  }

  let root = getProjectRoot(input.project);

  if (!root) {
    root = createNode({
      project: input.project,
      summary: input.goal ?? input.project,
      agent,
    });
  }

  const summary = getProjectSummary(input.project);

  return { root, summary };
}
