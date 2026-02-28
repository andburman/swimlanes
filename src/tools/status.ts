import { getDb } from "../db.js";
import { getProjectRoot, getProjectSummary, listProjects } from "../nodes.js";
import { optionalString } from "../validate.js";
import { EngineError } from "../validate.js";
import { computeContinuityConfidence } from "../continuity.js";
import { computeIntegrity } from "../integrity.js";
import type { NodeRow, Evidence } from "../types.js";

export interface StatusInput {
  project?: string;
}

export interface StatusResult {
  formatted: string;
  project: string;
}

interface TreeEntry {
  id: string;
  parent: string | null;
  summary: string;
  resolved: boolean;
  blocked: boolean;
  blocked_reason: string | null;
  depth: number;
  child_count: number;
  dep_blocked: boolean;
  resolved_children: number;
  total_children: number;
}

function statusIcon(entry: TreeEntry): string {
  if (entry.resolved) return "x";
  if (entry.blocked) return "!";
  if (entry.dep_blocked) return "~";
  return " ";
}

function progressBar(resolved: number, total: number, width: number = 20): string {
  if (total === 0) return "";
  const clamped = Math.min(resolved, total);
  const filled = Math.round((clamped / total) * width);
  const empty = width - filled;
  const bar = "\u2588".repeat(filled) + "\u2591".repeat(empty);
  const pct = Math.round((resolved / total) * 100);
  return `${bar} ${resolved}/${total} (${pct}%)`;
}

function timeAgo(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  return `${days}d ago`;
}

export function handleStatus(input: StatusInput): StatusResult | { projects: ReturnType<typeof listProjects>; hint: string } {
  const db = getDb();

  let project = optionalString(input?.project, "project");
  if (!project) {
    const projects = listProjects();
    if (projects.length === 0) {
      return {
        projects: [],
        hint: "No projects yet. Create one with graph_open({ project: \"my-project\", goal: \"...\" }).",
      };
    }
    if (projects.length === 1) {
      project = projects[0].project;
    } else {
      const lines: string[] = ["# All Projects", ""];
      for (const p of projects) {
        const taskCount = p.total > 0 ? p.total - 1 : 0; // exclude root
        const resolvedTasks = Math.min(p.resolved, taskCount);
        const bar = taskCount > 0 ? progressBar(resolvedTasks, taskCount) : "empty";
        lines.push(`**${p.project}** ${bar}`);
        lines.push(`  ${p.summary}`);
        lines.push("");
      }
      lines.push("_Specify a project name for details._");
      return { projects, hint: lines.join("\n") };
    }
  }

  const root = getProjectRoot(project);
  if (!root) {
    const available = listProjects();
    const names = available.map((p) => p.project);
    const suffix = names.length > 0
      ? ` Available projects: ${names.join(", ")}`
      : " No projects exist yet.";
    throw new EngineError("project_not_found", `Project not found: ${project}.${suffix}`);
  }

  const summary = getProjectSummary(project);

  // Get all non-root nodes with subtree counts and dependency info
  const rows = db.prepare(
    `SELECT n.id, n.parent, n.summary, n.resolved, n.blocked, n.blocked_reason, n.depth,
       (SELECT COUNT(*) FROM nodes c WHERE c.parent = n.id) as child_count,
       (SELECT COUNT(*) FROM nodes c WHERE c.parent = n.id AND c.resolved = 1) as resolved_children,
       (SELECT COUNT(*) FROM edges e
        JOIN nodes dep ON dep.id = e.to_node AND dep.resolved = 0
        WHERE e.from_node = n.id AND e.type = 'depends_on') as unresolved_deps
     FROM nodes n
     WHERE n.project = ? AND n.parent IS NOT NULL
     ORDER BY n.depth ASC, n.created_at ASC`
  ).all(project) as Array<{
    id: string;
    parent: string | null;
    summary: string;
    resolved: number;
    blocked: number;
    blocked_reason: string | null;
    depth: number;
    child_count: number;
    resolved_children: number;
    unresolved_deps: number;
  }>;

  const entries: TreeEntry[] = rows.map(r => ({
    id: r.id,
    parent: r.parent,
    summary: r.summary,
    resolved: r.resolved === 1,
    blocked: r.blocked === 1,
    blocked_reason: r.blocked_reason,
    depth: r.depth - 1, // relative to root
    child_count: r.child_count,
    dep_blocked: r.unresolved_deps > 0,
    resolved_children: r.resolved_children,
    total_children: r.child_count,
  }));

  // [sl:fQiULd-y8wnR-2W_TsUN-] Fetch dependency info for dep-blocked nodes
  const depBlockedIds = entries.filter(e => e.dep_blocked && !e.resolved).map(e => e.id);
  const depMap = new Map<string, string[]>();
  if (depBlockedIds.length > 0) {
    const ph = depBlockedIds.map(() => "?").join(",");
    const depRows = db.prepare(
      `SELECT e.from_node, n.summary FROM edges e
       JOIN nodes n ON n.id = e.to_node AND n.resolved = 0
       WHERE e.from_node IN (${ph}) AND e.type = 'depends_on'`
    ).all(...depBlockedIds) as Array<{ from_node: string; summary: string }>;
    for (const r of depRows) {
      const existing = depMap.get(r.from_node) ?? [];
      existing.push(r.summary);
      depMap.set(r.from_node, existing);
    }
  }

  // Build formatted output
  const lines: string[] = [];
  const taskCount = summary.total - 1; // exclude root

  // Header with progress bar
  lines.push(`# ${project}`);
  lines.push("");
  lines.push(root.summary);
  lines.push("");
  const resolvedTasks = Math.min(summary.resolved, taskCount);
  const integrity = computeIntegrity(project);
  if (taskCount > 0) {
    lines.push(progressBar(resolvedTasks, taskCount));
    // Continuity confidence signal
    const cc = computeContinuityConfidence(project);
    const ccBars = Math.ceil(cc.score / 20); // 0-5 filled blocks
    const ccDisplay = "\u25a0".repeat(ccBars) + "\u25a1".repeat(5 - ccBars);
    // [sl:Aqr3gbYg_XDgv2YOj8_qb] Quality KPI in header
    const qk = integrity.quality_kpi;
    const qkLabel = qk.resolved > 0 ? ` | quality: ${qk.percentage}% (${qk.high_quality}/${qk.resolved})` : "";
    lines.push(`${summary.actionable} actionable | ${summary.blocked} blocked | ${summary.unresolved - summary.blocked - summary.actionable} waiting | continuity confidence: ${cc.confidence} ${ccDisplay}${qkLabel}`);
    if (cc.reasons.length > 0 && cc.confidence !== "high") {
      for (const reason of cc.reasons) {
        lines.push(`  - ${reason}`);
      }
    }
  } else {
    lines.push("No tasks yet");
  }
  lines.push("");

  // Task tree with indentation and inline progress for parents
  if (entries.length > 0) {
    lines.push("## Tasks");
    lines.push("");
    for (const entry of entries) {
      const icon = statusIcon(entry);
      const prefix = "  ".repeat(entry.depth);
      let line = `${prefix}[${icon}] ${entry.summary}`;

      // Inline progress for parent nodes
      if (entry.child_count > 0) {
        const pct = Math.round((entry.resolved_children / entry.total_children) * 100);
        line += ` (${entry.resolved_children}/${entry.total_children} — ${pct}%)`;
      }

      // Blocked reason inline
      if (entry.blocked && entry.blocked_reason) {
        line += `\n${prefix}    ^ ${entry.blocked_reason}`;
      }

      // Dependency blocked — show what it's waiting on
      if (entry.dep_blocked && !entry.resolved && !entry.blocked) {
        const deps = depMap.get(entry.id);
        if (deps && deps.length > 0) {
          const depList = deps.length <= 2 ? deps.join(", ") : `${deps[0]} +${deps.length - 1} more`;
          line += `\n${prefix}    ^ waiting on: ${depList}`;
        }
      }

      lines.push(line);
    }
    lines.push("");
  }

  // Recent activity — last 5 events across the project
  const recentEvents = db.prepare(
    `SELECT e.node_id, e.agent, e.action, e.timestamp, n.summary as node_summary
     FROM events e
     JOIN nodes n ON n.id = e.node_id
     WHERE n.project = ?
     ORDER BY e.timestamp DESC
     LIMIT 5`
  ).all(project) as Array<{
    node_id: string;
    agent: string;
    action: string;
    timestamp: string;
    node_summary: string;
  }>;

  if (recentEvents.length > 0) {
    lines.push("## Recent Activity");
    lines.push("");
    for (const ev of recentEvents) {
      lines.push(`- ${ev.action} **${ev.node_summary}** (${ev.agent}, ${timeAgo(ev.timestamp)})`);
    }
    lines.push("");
  }

  // Blocked items
  const blocked = entries.filter(e => e.blocked && e.blocked_reason);
  if (blocked.length > 0) {
    lines.push("## Blocked");
    lines.push("");
    for (const b of blocked) {
      lines.push(`- **${b.summary}** — ${b.blocked_reason}`);
    }
    lines.push("");
  }

  // Knowledge entries
  const knowledge = db.prepare(
    "SELECT key, updated_at FROM knowledge WHERE project = ? ORDER BY updated_at DESC"
  ).all(project) as Array<{ key: string; updated_at: string }>;
  if (knowledge.length > 0) {
    lines.push("## Knowledge");
    lines.push("");
    for (const k of knowledge) {
      lines.push(`- ${k.key} (${timeAgo(k.updated_at)})`);
    }
    lines.push("");
  }

  // [sl:7bQaAQjJZnY7-ItScrtip] Integrity audit section
  if (integrity.issues.length > 0) {
    lines.push("## Integrity");
    lines.push("");
    lines.push(`Score: ${integrity.score}/100 — ${integrity.issues.length} issue(s)`);
    lines.push("");

    // Group by type
    const grouped = new Map<string, typeof integrity.issues>();
    for (const issue of integrity.issues) {
      const group = grouped.get(issue.type) ?? [];
      group.push(issue);
      grouped.set(issue.type, group);
    }

    const typeLabels: Record<string, string> = {
      weak_evidence: "Weak Evidence",
      stale_claim: "Stale Claims",
      orphan: "Orphan Nodes",
      stale_task: "Stale Tasks",
    };

    for (const [type, items] of grouped) {
      lines.push(`**${typeLabels[type] ?? type}** (${items.length})`);
      for (const item of items.slice(0, 5)) {
        lines.push(`- ${item.summary} — ${item.detail}`);
        lines.push(`  fix: ${item.suggestion}`);
      }
      if (items.length > 5) {
        lines.push(`- _...and ${items.length - 5} more_`);
      }
      lines.push("");
    }
  }

  return {
    formatted: lines.join("\n").trimEnd(),
    project,
  };
}
