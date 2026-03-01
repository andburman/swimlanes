import { execSync } from "child_process";
import { getNodeOrThrow } from "../nodes.js";
import { handleUpdate } from "./update.js";
import { handleKnowledgeWrite } from "./knowledge.js";
import { requireString } from "../validate.js";

// [sl:Pj4XxpNqIbtR1EoZv9jxt] One-call resolve helper — auto-collects git evidence

export interface ResolveInput {
  node_id: string;
  message: string;
  test_result?: string;
  commit?: string;
  context_links?: string[];
  // [sl:g51sz-5sGTtq1AzTh-_io] Inline knowledge write — capture findings in same call
  knowledge?: { key: string; content: string };
  decision_context?: string; // [sl:M8jj8RzospuObjRJiDMRS]
}

export interface ResolveResult {
  node_id: string;
  rev: number;
  evidence_collected: {
    git_commits: number;
    context_links: number;
    has_note: boolean;
    has_test: boolean;
  };
  newly_actionable?: Array<{ id: string; summary: string }>;
  auto_resolved?: Array<{ node_id: string; summary: string }>;
  knowledge_written?: string;
}

function tryGitCommits(since?: string, max: number = 10): Array<{ hash: string; message: string }> {
  try {
    const sinceArg = since ? `--since="${since}"` : "";
    const output = execSync(
      `git log ${sinceArg} --oneline --no-decorate -${max}`,
      { encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] }
    ).trim();
    if (!output) return [];
    return output.split("\n").map(line => {
      const spaceIdx = line.indexOf(" ");
      return {
        hash: line.slice(0, spaceIdx),
        message: line.slice(spaceIdx + 1),
      };
    });
  } catch {
    return [];
  }
}

function tryGitModifiedFiles(since?: string): string[] {
  try {
    const sinceArg = since ? `--since="${since}"` : "";
    const output = execSync(
      `git log ${sinceArg} --name-only --pretty=format:""`,
      { encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] }
    ).trim();
    if (!output) return [];
    return [...new Set(output.split("\n").filter(Boolean))];
  } catch {
    return [];
  }
}

export function handleResolve(input: ResolveInput, agent: string): ResolveResult {
  const node_id = requireString(input?.node_id, "node_id");
  const message = requireString(input?.message, "message");

  const node = getNodeOrThrow(node_id);
  const claimedAt = node.properties._claimed_at as string | undefined;

  // Collect evidence
  const evidence: Array<{ type: string; ref: string }> = [];

  // Git evidence: explicit commit or auto-detect
  if (input.commit) {
    evidence.push({ type: "git", ref: input.commit });
  } else {
    const commits = tryGitCommits(claimedAt);
    for (const c of commits) {
      evidence.push({ type: "git", ref: `${c.hash} — ${c.message}` });
    }
  }

  // Note evidence (always present)
  evidence.push({ type: "note", ref: message });

  // Test evidence (optional)
  if (input.test_result) {
    evidence.push({ type: "test", ref: input.test_result });
  }

  // Context links: explicit or auto-detect from git
  let contextLinks = input.context_links;
  if (!contextLinks || contextLinks.length === 0) {
    contextLinks = tryGitModifiedFiles(claimedAt);
  }

  // Resolve via graph_update (reuses transaction, auto-resolve, newly_actionable)
  const result = handleUpdate({
    updates: [{
      node_id,
      resolved: true,
      add_evidence: evidence,
      add_context_links: contextLinks,
    }],
    decision_context: input.decision_context,
  }, agent);

  // [sl:g51sz-5sGTtq1AzTh-_io] Inline knowledge write — source_node auto-set to resolved node
  let knowledge_written: string | undefined;
  if (input.knowledge?.key && input.knowledge?.content) {
    handleKnowledgeWrite({
      project: node.project,
      key: input.knowledge.key,
      content: input.knowledge.content,
      source_node: node_id,
    }, agent);
    knowledge_written = input.knowledge.key;
  }

  return {
    node_id,
    rev: result.updated[0].rev,
    evidence_collected: {
      git_commits: evidence.filter(e => e.type === "git").length,
      context_links: contextLinks?.length ?? 0,
      has_note: true,
      has_test: !!input.test_result,
    },
    newly_actionable: result.newly_actionable,
    auto_resolved: result.auto_resolved,
    knowledge_written,
  };
}
