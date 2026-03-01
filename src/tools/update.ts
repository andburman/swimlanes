import { getDb } from "../db.js";
import { updateNode, getNode, getNodeOrThrow, getChildren, getProjectRoot } from "../nodes.js";
import { findNewlyActionable } from "../edges.js";
import { requireArray, requireString, EngineError } from "../validate.js";
// [sl:k2dMFzFIn-gK_A9KjK6-D] Batch updates wrapped in transaction

export interface UpdateEntry {
  node_id: string;
  expected_rev?: number;
  resolved?: boolean;
  resolved_reason?: string; // [sl:QBEtldx8PBWACftEM8MYl] Shorthand — auto-creates note evidence
  discovery?: string | null;
  blocked?: boolean;
  blocked_reason?: string | null;
  plan?: string[] | null;
  state?: unknown;
  summary?: string;
  properties?: Record<string, unknown>;
  add_context_links?: string[];
  remove_context_links?: string[];
  add_evidence?: Array<{ type: string; ref: string }>;
}

export interface UpdateInput {
  updates: UpdateEntry[];
  decision_context?: string; // [sl:M8jj8RzospuObjRJiDMRS]
}

export interface AutoResolvedEntry {
  node_id: string;
  summary: string;
  children_summary?: Array<{ id: string; summary: string; resolved_at: string }>;
}

export interface UpdateResult {
  updated: Array<{ node_id: string; rev: number }>;
  newly_actionable?: Array<{ id: string; summary: string }>;
  auto_resolved?: AutoResolvedEntry[];
  evidence_warnings?: string[];
  retro_nudge?: string;
}

export function handleUpdate(input: UpdateInput, agent: string): UpdateResult {
  const updates = requireArray<UpdateEntry>(input?.updates, "updates");

  for (let i = 0; i < updates.length; i++) {
    requireString(updates[i].node_id, `updates[${i}].node_id`);
    if (updates[i].add_evidence) {
      for (let j = 0; j < updates[i].add_evidence!.length; j++) {
        requireString(updates[i].add_evidence![j].type, `updates[${i}].add_evidence[${j}].type`);
        requireString(updates[i].add_evidence![j].ref, `updates[${i}].add_evidence[${j}].ref`);
      }
    }
  }

  const db = getDb();
  const updated: Array<{ node_id: string; rev: number }> = [];
  const resolvedIds: string[] = [];
  const resolvedProjects = new Set<string>();
  const autoResolved: AutoResolvedEntry[] = [];

  const runUpdates = db.transaction(() => {
  for (const entry of updates) {
    // Optimistic concurrency: reject if rev doesn't match
    if (entry.expected_rev !== undefined) {
      const current = getNodeOrThrow(entry.node_id);
      if (current.rev !== entry.expected_rev) {
        throw new EngineError(
          "rev_mismatch",
          `Node ${entry.node_id} has rev ${current.rev}, expected ${entry.expected_rev}. Another agent may have modified it. Re-read and retry.`
        );
      }
    }

    // [sl:0hYsWpHub_T8Z3ser3WvT] Block manual resolve when parent has unresolved children
    if (entry.resolved === true) {
      const current = getNodeOrThrow(entry.node_id);
      if (!current.resolved) {
        const children = getChildren(entry.node_id);
        const unresolved = children.filter(c => !c.resolved);
        if (unresolved.length > 0) {
          const list = unresolved.slice(0, 5).map(c => `${c.id} "${c.summary}"`).join(", ");
          const more = unresolved.length > 5 ? ` +${unresolved.length - 5} more` : "";
          throw new EngineError(
            "unresolved_children",
            `Cannot resolve: ${unresolved.length} unresolved child(ren) (${list}${more}). Move them with graph_restructure or drop them with graph_update first.`
          );
        }
      }
    }

    // Expand resolved_reason shorthand into evidence
    let evidence = entry.add_evidence;
    if (entry.resolved_reason) {
      evidence = [...(evidence ?? []), { type: "note", ref: entry.resolved_reason }];
    }

    const node = updateNode({
      node_id: entry.node_id,
      agent,
      resolved: entry.resolved,
      discovery: entry.discovery,
      blocked: entry.blocked,
      blocked_reason: entry.blocked_reason,
      plan: entry.plan,
      state: entry.state,
      summary: entry.summary,
      properties: entry.properties,
      add_context_links: entry.add_context_links,
      remove_context_links: entry.remove_context_links,
      add_evidence: evidence,
      decision_context: input.decision_context,
    });

    // [sl:rIuWFYZUQAhN0ViM9y0Ey] Strict solo mode enforcement on resolve
    if (entry.resolved === true) {
      const root = getProjectRoot(node.project);
      if (root && root.properties.strict === true) {
        const ev = Array.isArray(node.evidence) ? node.evidence : [];
        const links = Array.isArray(node.context_links) ? node.context_links : [];
        // Skip check for auto-resolved parents (they inherit quality from children)
        const isAutoResolve = false; // explicit resolve, not auto
        if (!isAutoResolve) {
          const hasNote = ev.some((e: { type: string }) => e.type === "note");
          const hasTraceableArtifact = ev.some((e: { type: string }) => e.type === "git" || e.type === "test");
          const hasLinks = links.length > 0;
          const missing: string[] = [];
          if (!hasNote) missing.push("note evidence (what was done)");
          if (!hasTraceableArtifact) missing.push("git or test evidence (traceable artifact)");
          if (!hasLinks) missing.push("context_links (files modified)");
          if (missing.length > 0) {
            throw new EngineError(
              "strict_mode_violation",
              `Strict mode requires: ${missing.join(", ")}. Use graph_resolve for automatic evidence collection, or add manually via add_evidence and add_context_links.`
            );
          }
        }
      }
    }

    updated.push({ node_id: node.id, rev: node.rev });

    if (entry.resolved === true) {
      resolvedIds.push(node.id);
      resolvedProjects.add(node.project);
    }
  }

  // [sl:GBuFbmTFuFfnl5KWW-ja-] [sl:0hYsWpHub_T8Z3ser3WvT] Auto-resolve parents when all children are resolved
  // Default: cascade 1 level. Opt-out: properties.auto_resolve === false.
  // Unlimited cascade: properties.cascade_resolve === true on the auto-resolved parent.
  if (resolvedIds.length > 0) {
    const seen = new Set<string>(resolvedIds);
    const queue = [...resolvedIds];

    while (queue.length > 0) {
      const nodeId = queue.shift()!;
      const node = getNode(nodeId);
      if (!node?.parent) continue;

      const parentId = node.parent;
      if (seen.has(parentId)) continue;
      seen.add(parentId);

      const parent = getNode(parentId);
      if (!parent || parent.resolved) continue;

      // Opt-out: skip if parent explicitly disabled auto-resolve
      if (parent.properties.auto_resolve === false) continue;

      const children = getChildren(parentId);
      if (children.length === 0) continue;
      if (children.every((c) => c.resolved)) {
        // Build children summary for evidence
        const childrenSummary = children.map(c => ({
          id: c.id,
          summary: c.summary,
          resolved_at: c.updated_at,
        }));
        const resolved = updateNode({
          node_id: parentId,
          agent,
          resolved: true,
          add_evidence: [{
            type: "auto_resolve",
            ref: `${children.length}/${children.length} children resolved`,
          }],
        });
        updated.push({ node_id: resolved.id, rev: resolved.rev });
        resolvedIds.push(parentId);
        autoResolved.push({ node_id: parentId, summary: parent.summary, children_summary: childrenSummary });

        // Cascade control: only continue up if the just-resolved parent has cascade_resolve: true,
        // OR if the trigger was a directly resolved node (1 level default).
        // After 1 auto-resolve, stop unless cascade_resolve is set.
        if (parent.properties.cascade_resolve === true) {
          queue.push(parentId);
        }
        // Default: don't push to queue — stops after 1 level
      }
    }
  }
  }); // end transaction

  runUpdates();

  const result: UpdateResult = { updated };

  if (resolvedIds.length > 0 && resolvedProjects.size > 0) {
    const allActionable: Array<{ id: string; summary: string }> = [];
    for (const proj of resolvedProjects) {
      allActionable.push(...findNewlyActionable(proj, resolvedIds));
    }
    result.newly_actionable = allActionable;
  }

  if (autoResolved.length > 0) {
    result.auto_resolved = autoResolved;
  }

  // [sl:28Sw7t6y1rBKRHctk7BY8] Warn on thin evidence at resolve time
  // [sl:n4hDdI5Ir37Xf93mb1bE-] Warn on missing context links at resolve time
  const autoResolvedIds = new Set(autoResolved.map(a => a.node_id));
  const evidenceWarnings: string[] = [];
  for (const entry of updates) {
    if (entry.resolved !== true) continue;
    if (autoResolvedIds.has(entry.node_id)) continue;
    const node = getNode(entry.node_id);
    if (!node) continue;
    const ev = Array.isArray(node.evidence) ? node.evidence : [];
    const hasGit = ev.some((e: { type: string }) => e.type === "git");
    const hasTest = ev.some((e: { type: string }) => e.type === "test");
    if (ev.length <= 1 || (!hasGit && !hasTest)) {
      const missing: string[] = [];
      if (ev.length <= 1) missing.push("only " + ev.length + " evidence entry");
      if (!hasGit) missing.push("no git evidence");
      if (!hasTest) missing.push("no test evidence");
      evidenceWarnings.push(`Node "${node.summary}" (${node.id}): thin evidence — ${missing.join(", ")}. Consider adding git commits and test results for better traceability.`);
    }
    const links = Array.isArray(node.context_links) ? node.context_links : [];
    const children = getChildren(node.id);
    if (links.length === 0 && children.length === 0) {
      evidenceWarnings.push(`Node "${node.summary}" (${node.id}): no context_links — add file paths you modified so the next agent knows what was touched.`);
    }
    // [sl:T_0xWAclj0nui4ZwhqEEj] Discovery gate on resolve — warn if leaf resolved with discovery:pending
    if (node.discovery === "pending" && children.length === 0) {
      evidenceWarnings.push(`Node "${node.summary}" (${node.id}): resolved with discovery still pending — consider running discovery first or flipping to done via graph_update.`);
    }
    // [sl:t2sGegBC__5J8T-SIZe2B] Plan compliance — warn if leaf resolved with no plan
    if (!node.plan && children.length === 0) {
      evidenceWarnings.push(`Node "${node.summary}" (${node.id}): resolved without a plan — record your approach via graph_update with plan: ["step 1", "step 2", ...] before resolving.`);
    }
  }
  if (evidenceWarnings.length > 0) {
    result.evidence_warnings = evidenceWarnings;
  }

  // [sl:ZlreTpaeFU0SvfjJysR9k] Retro nudge on milestone completion
  if (autoResolved.length > 0) {
    const parentNames = autoResolved.map(a => `"${a.summary}"`).join(", ");
    result.retro_nudge = `Milestone completed: ${parentNames} auto-resolved. Consider running graph_retro({ project: "..." }) to reflect on what worked and what didn't.`;
  }

  return result;
}
