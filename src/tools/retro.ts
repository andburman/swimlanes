// [sl:tBlHTpb416__sCU8gfE2b] graph_retro — structured retro tool for the improvement loop

import { nanoid } from "nanoid";
import { getDb } from "../db.js";
import { getProjectRoot } from "../nodes.js";
import { requireString, EngineError } from "../validate.js";
import type { Evidence } from "../types.js";

export interface RetroFinding {
  category: "claude_md_candidate" | "knowledge_gap" | "workflow_improvement" | "bug_or_debt" | "knowledge_drift";
  insight: string;
  suggestion?: string; // For claude_md_candidate: the recommended CLAUDE.md instruction text
}

export interface RetroInput {
  project: string;
  scope?: string; // Optional node ID to scope the retro to a subtree
  findings?: RetroFinding[];
}

export interface RetroContext {
  resolved_since_last_retro: Array<{
    id: string;
    summary: string;
    evidence: Evidence[];
    resolved_at: string;
    agent: string;
  }>;
  time_span: {
    earliest: string | null;
    latest: string | null;
  };
  task_count: number;
  // Knowledge entries for cross-referencing against resolved work (excerpted to save tokens)
  knowledge_entries: Array<{
    key: string;
    excerpt: string;
    updated_at: string;
  }>;
}

export interface RetroResult {
  project: string;
  context: RetroContext;
  stored?: {
    key: string;
    finding_count: number;
    claude_md_candidates: Array<{ insight: string; suggestion: string }>;
  };
  hint: string;
}

export function handleRetro(input: RetroInput, agent: string): RetroResult {
  const db = getDb();
  const project = requireString(input?.project, "project");

  const root = getProjectRoot(project);
  if (!root) {
    // List available projects for self-correction
    const projects = db.prepare("SELECT DISTINCT project FROM nodes WHERE parent IS NULL").all() as Array<{ project: string }>;
    const available = projects.map(p => p.project).join(", ");
    throw new EngineError(
      "project_not_found",
      `Project not found: ${project}. Available projects: ${available || "(none)"}`
    );
  }

  // Find the most recent retro knowledge entry to determine "since last retro"
  const lastRetro = db.prepare(
    "SELECT updated_at FROM knowledge WHERE project = ? AND key LIKE 'retro-%' ORDER BY updated_at DESC LIMIT 1"
  ).get(project) as { updated_at: string } | undefined;

  const sinceDate = lastRetro?.updated_at ?? "1970-01-01T00:00:00.000Z";

  // Gather recently resolved tasks (since last retro)
  let resolvedQuery = `
    SELECT n.id, n.summary, n.evidence, n.updated_at, n.created_by
    FROM nodes n
    WHERE n.project = ? AND n.resolved = 1 AND n.parent IS NOT NULL
    AND n.updated_at > ?
  `;
  const queryParams: unknown[] = [project, sinceDate];

  // Scope to subtree if requested
  if (input.scope) {
    const descendantIds = db
      .prepare(
        `WITH RECURSIVE descendants(id) AS (
          SELECT id FROM nodes WHERE parent = ?
          UNION ALL
          SELECT n.id FROM nodes n JOIN descendants d ON n.parent = d.id
        )
        SELECT id FROM descendants`
      )
      .all(input.scope) as Array<{ id: string }>;

    if (descendantIds.length > 0) {
      resolvedQuery += ` AND n.id IN (${descendantIds.map(() => "?").join(",")})`;
      queryParams.push(...descendantIds.map(d => d.id));
    }
  }

  resolvedQuery += " ORDER BY n.updated_at DESC LIMIT 50";

  const resolvedRows = db.prepare(resolvedQuery).all(...queryParams) as Array<{
    id: string;
    summary: string;
    evidence: string;
    updated_at: string;
    created_by: string;
  }>;

  const resolved_since_last_retro = resolvedRows.map(r => ({
    id: r.id,
    summary: r.summary,
    evidence: JSON.parse(r.evidence) as Evidence[],
    resolved_at: r.updated_at,
    agent: r.created_by,
  }));

  // Gather knowledge entries for cross-referencing (excerpted to save tokens)
  const knowledgeRows = db.prepare(
    "SELECT key, content, updated_at FROM knowledge WHERE project = ? AND key NOT LIKE 'retro-%' ORDER BY updated_at DESC"
  ).all(project) as Array<{ key: string; content: string; updated_at: string }>;

  const knowledge_entries = knowledgeRows.map(k => ({
    key: k.key,
    excerpt: k.content.length > 200 ? k.content.slice(0, 200) + "..." : k.content,
    updated_at: k.updated_at,
  }));

  const context: RetroContext = {
    resolved_since_last_retro,
    time_span: {
      earliest: resolvedRows.length > 0 ? resolvedRows[resolvedRows.length - 1].updated_at : null,
      latest: resolvedRows.length > 0 ? resolvedRows[0].updated_at : null,
    },
    task_count: resolvedRows.length,
    knowledge_entries,
  };

  // If no findings provided, return context for the agent to analyze
  if (!input.findings || input.findings.length === 0) {
    return {
      project,
      context,
      hint: context.task_count === 0 && knowledge_entries.length === 0
        ? "No resolved tasks since last retro and no knowledge entries. Nothing to reflect on yet."
        : context.task_count === 0
          ? `No resolved tasks since last retro, but ${knowledge_entries.length} knowledge entry(s) exist. Review for staleness or gaps, then call graph_retro with findings.`
          : `${context.task_count} task(s) resolved since last retro. ${knowledge_entries.length} knowledge entry(s) to cross-check. Review evidence against knowledge for drift, then call graph_retro with findings.`,
    };
  }

  // Validate findings
  const validCategories = new Set(["claude_md_candidate", "knowledge_gap", "workflow_improvement", "bug_or_debt", "knowledge_drift"]);
  for (let i = 0; i < input.findings.length; i++) {
    const f = input.findings[i];
    if (!f.category || !validCategories.has(f.category)) {
      throw new EngineError(
        "invalid_finding",
        `findings[${i}].category must be one of: ${[...validCategories].join(", ")}`
      );
    }
    if (!f.insight || typeof f.insight !== "string") {
      throw new EngineError(
        "invalid_finding",
        `findings[${i}].insight is required and must be a string`
      );
    }
  }

  // Store findings as a knowledge entry
  const timestamp = new Date().toISOString();
  const key = `retro-${timestamp.slice(0, 10)}-${Date.now().toString(36)}`;

  const categorized: Record<string, RetroFinding[]> = {};
  for (const f of input.findings) {
    if (!categorized[f.category]) categorized[f.category] = [];
    categorized[f.category].push(f);
  }

  // Build structured content
  const lines: string[] = [
    `## Retro — ${timestamp.slice(0, 10)}`,
    ``,
    `Tasks reviewed: ${context.task_count}`,
    context.time_span.earliest && context.time_span.latest
      ? `Period: ${context.time_span.earliest.slice(0, 10)} to ${context.time_span.latest.slice(0, 10)}`
      : "",
    `Agent: ${agent}`,
    ``,
  ];

  const categoryLabels: Record<string, string> = {
    claude_md_candidate: "CLAUDE.md Instruction Candidates",
    knowledge_gap: "Knowledge Gaps",
    workflow_improvement: "Workflow Improvements",
    bug_or_debt: "Bugs / Tech Debt",
    knowledge_drift: "Knowledge Drift",
  };

  for (const [cat, findings] of Object.entries(categorized)) {
    lines.push(`### ${categoryLabels[cat] ?? cat}`);
    for (const f of findings) {
      lines.push(`- ${f.insight}`);
      if (f.suggestion) {
        lines.push(`  > Suggested instruction: ${f.suggestion}`);
      }
    }
    lines.push("");
  }

  const content = lines.filter(l => l !== undefined).join("\n");

  // Store as knowledge entry (retro keys are unique by timestamp, so always insert)
  const id = nanoid();
  db.prepare(
    "INSERT INTO knowledge (id, project, key, content, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(id, project, key, content, agent, timestamp, timestamp);

  // Extract CLAUDE.md candidates for prominent surfacing
  const claude_md_candidates = (categorized["claude_md_candidate"] ?? [])
    .map(f => ({
      insight: f.insight,
      suggestion: f.suggestion ?? f.insight,
    }));

  return {
    project,
    context,
    stored: {
      key,
      finding_count: input.findings.length,
      claude_md_candidates,
    },
    hint: claude_md_candidates.length > 0
      ? `Retro stored as knowledge entry "${key}". ${claude_md_candidates.length} CLAUDE.md candidate(s) found — present these to the user for review.`
      : `Retro stored as knowledge entry "${key}". ${input.findings.length} finding(s) recorded.`,
  };
}
