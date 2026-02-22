import { createNode, getProjectRoot, listProjects, getProjectSummary } from "../nodes.js";
import { optionalString } from "../validate.js";
import type { Node } from "../types.js";

export interface OpenInput {
  project?: string;
  goal?: string;
}

export type OpenResult =
  | {
      projects: Array<{
        project: string;
        id: string;
        summary: string;
        total: number;
        resolved: number;
        unresolved: number;
        updated_at: string;
      }>;
    }
  | {
      project: string;
      root: Node;
      summary: {
        total: number;
        resolved: number;
        unresolved: number;
        blocked: number;
        actionable: number;
      };
      hint?: string;
    };

export function handleOpen(input: OpenInput, agent: string): OpenResult {
  const project = optionalString(input?.project, "project");
  const goal = optionalString(input?.goal, "goal");

  if (!project) {
    return { projects: listProjects() };
  }

  let root = getProjectRoot(project);
  let isNew = false;

  if (!root) {
    root = createNode({
      project,
      summary: goal ?? project,
      discovery: "pending",
      agent,
    });
    isNew = true;
  }

  const summary = getProjectSummary(project);

  const result: OpenResult = { project, root, summary };

  // Guide the agent on what to do next
  if (isNew && root.discovery === "pending") {
    result.hint = `New project created. Discovery is pending — interview the user to understand scope and goals, then set discovery to "done" via graph_update before decomposing with graph_plan.`;
  } else if (root.discovery === "pending") {
    result.hint = `Discovery is still pending on this project. Complete the discovery interview, then set discovery to "done" via graph_update.`;
  } else if (summary.actionable > 0) {
    result.hint = `${summary.actionable} actionable task(s). Use graph_next to claim one.`;
  } else if (summary.unresolved > 0 && summary.actionable === 0) {
    result.hint = `All remaining tasks are blocked. Check dependencies with graph_query.`;
  }

  return result;
}
