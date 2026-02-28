import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { setDbPath, closeDb, checkpointDb, resolveDbPath } from "./db.js";
import { ValidationError, EngineError } from "./validate.js";
import { handleOpen } from "./tools/open.js";
import { handlePlan } from "./tools/plan.js";
import { handleUpdate } from "./tools/update.js";
import { handleConnect } from "./tools/connect.js";
import { handleContext } from "./tools/context.js";
import { handleQuery } from "./tools/query.js";
import { handleNext } from "./tools/next.js";
import { handleRestructure } from "./tools/restructure.js";
import { handleHistory } from "./tools/history.js";
import { handleOnboard } from "./tools/onboard.js";
import { handleAgentConfig } from "./tools/agent-config.js";
import { handleTree } from "./tools/tree.js";
import { handleStatus } from "./tools/status.js";
import { handleKnowledgeWrite, handleKnowledgeRead, handleKnowledgeDelete, handleKnowledgeSearch } from "./tools/knowledge.js";
import { handleRetro } from "./tools/retro.js";
import { handleKnowledgeAudit } from "./tools/knowledge-audit.js";
import { handleResolve } from "./tools/resolve.js";
import { getLicenseTier, type Tier } from "./license.js";
import { checkNodeLimit, checkProjectLimit, capEvidenceLimit, checkScope, checkKnowledgeTier } from "./gates.js";

import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";

// Config from env
const AGENT_IDENTITY = process.env.GRAPH_AGENT ?? "default-agent";
const CLAIM_TTL = parseInt(process.env.GRAPH_CLAIM_TTL ?? "60", 10);

const DB_PATH = resolveDbPath();
mkdirSync(dirname(DB_PATH), { recursive: true });

// Read version from package.json
const PKG_NAME = "@graph-tl/graph";
let PKG_VERSION = "0.0.0";
try {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));
  PKG_VERSION = pkg.version;
} catch {}

// Version banner — shown once on first tool call
let versionBanner: string | null = `[graph] v${PKG_VERSION}`;

// Non-blocking version check against npm registry
let updateWarning: string | null = null;

/** Returns the current update warning (if any). Used by onboard to surface outdated hints. */
export function getUpdateWarning(): string | null {
  return updateWarning;
}

async function checkForUpdate(): Promise<void> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${PKG_NAME}/latest`);
    if (!res.ok) return;
    const data = await res.json() as { version: string };
    if (data.version !== PKG_VERSION) {
      updateWarning = `[graph] Update available: ${PKG_VERSION} → ${data.version}. Run: graph update (or npx @graph-tl/graph update)`;
    }
  } catch {}
}

// Auto-update agent file on first tool call
function checkAndUpdateAgentFile(): string[] {
  const notes: string[] = [];
  try {
    const projectRoot = resolve(".");
    const agentPath = join(projectRoot, ".claude", "agents", "graph.md");
    const latest = handleAgentConfig(PKG_VERSION).agent_file;

    if (existsSync(agentPath)) {
      const current = readFileSync(agentPath, "utf-8");
      if (current !== latest) {
        const match = current.match(/^---[\s\S]*?version:\s*(\S+)[\s\S]*?---/);
        const oldVersion = match?.[1] ?? "unknown";
        writeFileSync(agentPath, latest, "utf-8");
        notes.push(`[graph] Updated .claude/agents/graph.md (${oldVersion} → ${PKG_VERSION})`);
      }
    } else {
      mkdirSync(dirname(agentPath), { recursive: true });
      writeFileSync(agentPath, latest, "utf-8");
      notes.push(`[graph] Created .claude/agents/graph.md`);
    }

    // Check if CLAUDE.md has graph workflow instructions
    const claudeMdPath = join(projectRoot, "CLAUDE.md");
    if (!existsSync(claudeMdPath)) {
      notes.push(`[graph] CLAUDE.md not found. Run /init to create it, then "npx -y @graph-tl/graph init" to add graph workflow instructions. Without this, the default agent won't follow the graph loop.`);
    } else {
      const claudeMd = readFileSync(claudeMdPath, "utf-8");
      if (!claudeMd.includes("Graph workflow") && !claudeMd.includes("graph_onboard")) {
        notes.push(`[graph] CLAUDE.md exists but missing graph workflow instructions. Run "npx -y @graph-tl/graph init" to add them.`);
      }
    }
  } catch {}
  return notes;
}

// Tool definitions
const TOOLS = [
  {
    name: "graph_open",
    description:
      "Open an existing project or create a new one. Omit 'project' to list all projects. Returns project root node and summary stats (total, resolved, unresolved, blocked, actionable counts).",
    inputSchema: {
      type: "object" as const,
      properties: {
        project: {
          type: "string",
          description: "Project name (e.g. 'my-project'). Omit to list all projects.",
        },
        goal: {
          type: "string",
          description: "Project goal/description. Used on creation only.",
        },
      },
    },
  },
  {
    name: "graph_plan",
    description:
      "Batch create nodes with parent-child and dependency relationships in one atomic call. Use for decomposing work into subtrees. Each node needs a temp 'ref' for intra-batch references. parent_ref and depends_on can reference batch refs or existing node IDs.",
    inputSchema: {
      type: "object" as const,
      properties: {
        nodes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              ref: {
                type: "string",
                description: "Temp ID for referencing within this batch",
              },
              parent_ref: {
                type: "string",
                description:
                  "Parent: a ref from this batch OR an existing node ID",
              },
              summary: { type: "string" },
              context_links: {
                type: "array",
                items: { type: "string" },
                description: "Pointers to files, commits, URLs",
              },
              depends_on: {
                type: "array",
                items: { type: "string" },
                description:
                  "Refs within batch OR existing node IDs this depends on",
              },
              properties: {
                type: "object",
                description: "Freeform key-value properties",
              },
            },
            required: ["ref", "summary"],
          },
          description: "Nodes to create",
        },
      },
      required: ["nodes"],
    },
  },
  {
    name: "graph_next",
    description:
      "Get the next actionable node — an unresolved leaf with all dependencies resolved. Ranked by priority (from properties), depth, and least-recently-updated. Returns the node with ancestor chain, context links, and resolved dependency info. Use claim=true to soft-lock the node. When modifying code for this task, annotate key changes with // [sl:nodeId] so future agents can trace code back to this task.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project: { type: "string", description: "Project name (e.g. 'my-project'), not a node ID" },
        scope: {
          type: "string",
          description: "Node ID to scope results to. Only returns actionable descendants of this node.",
        },
        filter: {
          type: "object",
          description: "Match against node properties",
        },
        count: {
          type: "number",
          description: "Return top N nodes (default 1)",
        },
        claim: {
          type: "boolean",
          description:
            "If true, soft-lock returned nodes with agent identity",
        },
      },
      required: ["project"],
    },
  },
  {
    name: "graph_context",
    description:
      "Deep-read a node and its neighborhood: ancestors (scope chain), children tree (to configurable depth), dependency graph (what it depends on, what depends on it). Look for // [sl:nodeId] annotations in source files to find code tied to specific tasks.",
    inputSchema: {
      type: "object" as const,
      properties: {
        node_id: { type: "string", description: "Node ID to inspect" },
        depth: {
          type: "number",
          description: "Levels of children to return (default 2)",
        },
      },
      required: ["node_id"],
    },
  },
  {
    name: "graph_update",
    description:
      "Update one or more nodes. Can change resolved, state, summary, properties (merged), context_links, and add evidence. When resolving nodes, returns newly_actionable — nodes that became unblocked. ENFORCED: Resolving a node requires evidence — use resolved_reason (shorthand, auto-creates note) or add_evidence array (type: 'git' for commits, 'note' for what was done and why, 'test' for results). Also add context_links to files you modified.",
    inputSchema: {
      type: "object" as const,
      properties: {
        updates: {
          type: "array",
          items: {
            type: "object",
            properties: {
              node_id: { type: "string" },
              expected_rev: { type: "number", description: "Optimistic concurrency: reject if node's current rev doesn't match. Prevents silent overwrites by concurrent agents." },
              resolved: { type: "boolean" },
              resolved_reason: { type: "string", description: "Shorthand: auto-creates a note evidence entry. Use instead of add_evidence for simple cases." },
              discovery: { type: "string", description: "Discovery phase status: 'pending' or 'done'. Set to 'done' after completing discovery interview." },
              blocked: { type: "boolean", description: "Manually block/unblock a node. Blocked nodes are skipped by graph_next. Use for external blockers (e.g., waiting on domain purchase, another team)." },
              blocked_reason: { type: "string", description: "Why the node is blocked. Cleared automatically when unblocking." },
              plan: { type: "array", items: { type: "string" }, description: "Implementation plan as ordered steps. Record before coding. Set to null to clear." },
              state: { description: "Agent-defined state, any type" },
              summary: { type: "string" },
              properties: {
                type: "object",
                description:
                  "Merged into existing. Set a key to null to delete it.",
              },
              add_context_links: {
                type: "array",
                items: { type: "string" },
                description: "Files modified or created for this task. Add when resolving so future agents know what was touched.",
              },
              remove_context_links: {
                type: "array",
                items: { type: "string" },
              },
              add_evidence: {
                type: "array",
                description: "Evidence of work done. Always add when resolving. Types: 'git' (commit hash + summary), 'note' (what was implemented and why), 'test' (test results).",
                items: {
                  type: "object",
                  properties: {
                    type: { type: "string", description: "Evidence type: git, note, test, or custom" },
                    ref: { type: "string", description: "The evidence content — commit ref, implementation note, test result" },
                  },
                  required: ["type", "ref"],
                },
              },
            },
            required: ["node_id"],
          },
        },
      },
      required: ["updates"],
    },
  },
  {
    name: "graph_connect",
    description:
      "Add or remove edges between nodes. Types: 'depends_on' (with cycle detection), 'relates_to', or custom. Parent edges not allowed — use graph_restructure for reparenting.",
    inputSchema: {
      type: "object" as const,
      properties: {
        edges: {
          type: "array",
          items: {
            type: "object",
            properties: {
              from: { type: "string", description: "Source node ID" },
              to: { type: "string", description: "Target node ID" },
              type: {
                type: "string",
                description: "'depends_on', 'relates_to', or custom",
              },
              remove: {
                type: "boolean",
                description: "True to remove this edge",
              },
            },
            required: ["from", "to", "type"],
          },
        },
      },
      required: ["edges"],
    },
  },
  {
    name: "graph_query",
    description:
      "Search and filter nodes. Filters: resolved, properties, text, ancestor (descendants of), is_leaf, is_actionable, is_blocked, claimed_by. Supports sorting and cursor pagination.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project: { type: "string", description: "Project name (e.g. 'my-project'), not a node ID" },
        filter: {
          type: "object",
          properties: {
            resolved: { type: "boolean" },
            properties: { type: "object" },
            text: { type: "string", description: "Substring match on summary" },
            ancestor: {
              type: "string",
              description: "Return all descendants of this node",
            },
            has_evidence_type: { type: "string" },
            is_leaf: { type: "boolean" },
            is_actionable: { type: "boolean" },
            is_blocked: { type: "boolean" },
            claimed_by: {
              type: ["string", "null"],
              description: "Filter by claim. null = unclaimed.",
            },
          },
        },
        sort: {
          type: "string",
          enum: ["readiness", "depth", "recent", "created"],
        },
        limit: { type: "number", description: "Max results (default 20, max 100)" },
        cursor: { type: "string", description: "Pagination cursor" },
      },
      required: ["project"],
    },
  },
  {
    name: "graph_restructure",
    description:
      "Modify graph structure: move (reparent), merge (combine two nodes), drop (resolve node + subtree with reason), delete (permanently remove node + subtree). Atomic. Reports newly_actionable nodes.",
    inputSchema: {
      type: "object" as const,
      properties: {
        operations: {
          type: "array",
          items: {
            type: "object",
            properties: {
              op: {
                type: "string",
                enum: ["move", "merge", "drop", "delete"],
              },
              node_id: { type: "string", description: "For move and drop" },
              new_parent: { type: "string", description: "For move" },
              source: { type: "string", description: "For merge: node to absorb" },
              target: {
                type: "string",
                description: "For merge: node that survives",
              },
              reason: { type: "string", description: "For drop: why" },
            },
            required: ["op"],
          },
        },
      },
      required: ["operations"],
    },
  },
  {
    name: "graph_history",
    description:
      "Read the audit trail for a node. Shows who changed what, when, and why. Useful for understanding past decisions across sessions.",
    inputSchema: {
      type: "object" as const,
      properties: {
        node_id: { type: "string" },
        limit: { type: "number", description: "Max events (default 20)" },
        cursor: { type: "string", description: "Pagination cursor" },
      },
      required: ["node_id"],
    },
  },
  {
    name: "graph_onboard",
    description:
      "Single-call orientation for agents joining a project. Default (brief) returns project summary, tree structure, recommended next task, continuity confidence, and flagged issues — enough to orient and start working. Use detail: \"full\" when you need evidence history, context links, knowledge entries, and the complete checklist. Drill deeper with graph_context, graph_next, graph_status, or graph_knowledge_read as needed.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project: { type: "string", description: "Project name (e.g. 'my-project'). Omit to auto-select (works when there's exactly one project)." },
        detail: {
          type: "string",
          enum: ["brief", "full"],
          description: "Response detail level. 'brief' (default) returns minimal orientation context. 'full' returns everything including evidence, context links, knowledge, and complete checklist.",
        },
        evidence_limit: {
          type: "number",
          description: "Max evidence entries to return in full mode (default 20, max 50)",
        },
        strict: {
          type: "boolean",
          description: "When true and checklist has action items, prepend a warning to the hint. Recommended for automated/unattended sessions.",
        },
      },
    },
  },
  {
    name: "graph_tree",
    description:
      "Full tree visualization for a project. Returns the complete task hierarchy with resolve status. Use when you need to see the whole project structure beyond graph_context's single-node neighborhood.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project: { type: "string", description: "Project name (e.g. 'my-project')" },
        depth: {
          type: "number",
          description: "Max tree depth to return (default 10, max 20)",
        },
      },
      required: ["project"],
    },
  },
  {
    name: "graph_status",
    description:
      "Returns a pre-formatted markdown summary of a project's current state. Use this to present project status to the user — output the `formatted` field directly. Shows task tree with status tags, actionable items, blocked items, and knowledge entries. Omit project to auto-select or get multi-project overview.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project: {
          type: "string",
          description: "Project name. Omit to auto-select (works when there's exactly one project).",
        },
      },
    },
  },
  {
    name: "graph_agent_config",
    description:
      "Returns the graph-optimized agent configuration file for Claude Code. Save the returned content to .claude/agents/graph.md to enable the graph workflow agent.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "graph_knowledge_write",
    description:
      "Write a knowledge entry for a project. Creates or overwrites a named document. Use for persistent project-level knowledge (architecture decisions, conventions, API contracts) that outlives individual tasks. Check existing entries first to avoid duplicates.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project: { type: "string", description: "Project name" },
        key: { type: "string", description: "Knowledge entry key. Use lowercase hyphenated names (e.g. 'auth-strategy', 'db-schema', 'api-contracts')" },
        content: { type: "string", description: "Free-form text content" },
        category: {
          type: "string",
          enum: ["general", "architecture", "convention", "decision", "environment", "api-contract", "discovery"],
          description: "Entry category. Defaults to 'general'. Use to organize entries and improve overlap detection.",
        },
        source_node: { type: "string", description: "Node ID this knowledge was written during. Auto-detected from agent's claimed node if omitted." },
      },
      required: ["project", "key", "content"],
    },
  },
  {
    name: "graph_knowledge_read",
    description:
      "Read knowledge entries for a project. Provide a key to read one entry, or omit to list all entries.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project: { type: "string", description: "Project name" },
        key: { type: "string", description: "Knowledge entry key. Omit to list all." },
      },
      required: ["project"],
    },
  },
  {
    name: "graph_knowledge_delete",
    description:
      "Delete a knowledge entry from a project.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project: { type: "string", description: "Project name" },
        key: { type: "string", description: "Knowledge entry key to delete" },
      },
      required: ["project", "key"],
    },
  },
  {
    name: "graph_knowledge_search",
    description:
      "Search knowledge entries by substring match on key or content.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project: { type: "string", description: "Project name" },
        query: { type: "string", description: "Search string" },
      },
      required: ["project", "query"],
    },
  },
  {
    name: "graph_knowledge_audit",
    description:
      "Deep-clean audit of knowledge entries. Token-optimized: returns full content only for flagged entries (stale 30d+, overlapping keys, orphaned source node). Healthy entries return key + category + days_stale only. Use for periodic knowledge hygiene — consolidating duplicates, removing stale entries, fixing contradictions. For lightweight drift detection during regular work, use graph_retro instead.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project: { type: "string", description: "Project name" },
      },
      required: ["project"],
    },
  },
  {
    name: "graph_retro",
    description:
      "Run a structured retro on recent work. Call once without findings to get context (recently resolved tasks + evidence since last retro, plus knowledge entries for cross-checking), then call again with categorized findings. Stores retro as a knowledge entry and surfaces CLAUDE.md instruction candidates. Compare resolved work against knowledge entries to detect drift (contradictions, outdated information, nomenclature inconsistency).",
    inputSchema: {
      type: "object" as const,
      properties: {
        project: { type: "string", description: "Project name" },
        scope: { type: "string", description: "Optional node ID to scope the retro to a subtree" },
        findings: {
          type: "array",
          description: "Structured retro findings. Omit on first call to get context.",
          items: {
            type: "object",
            properties: {
              category: {
                type: "string",
                enum: ["claude_md_candidate", "knowledge_gap", "workflow_improvement", "bug_or_debt", "knowledge_drift"],
                description: "Finding category. Use knowledge_drift when a knowledge entry contradicts recent work, uses outdated terminology, or contains stale information.",
              },
              insight: { type: "string", description: "What was observed" },
              suggestion: { type: "string", description: "For claude_md_candidate: the recommended CLAUDE.md instruction text. For knowledge_drift: which entry to update and how." },
            },
            required: ["category", "insight"],
          },
        },
      },
      required: ["project"],
    },
  },
  {
    name: "graph_resolve",
    description:
      "Resolve a node with auto-collected evidence. Automatically detects recent git commits and modified files since the node was claimed. Simpler than graph_update — just provide node_id and a message. Recommended way to resolve tasks.",
    inputSchema: {
      type: "object" as const,
      properties: {
        node_id: { type: "string", description: "Node to resolve" },
        message: { type: "string", description: "What was done and why" },
        test_result: { type: "string", description: "Test results summary (e.g. '203 tests passing')" },
        commit: { type: "string", description: "Specific commit ref to use instead of auto-detection" },
        context_links: {
          type: "array",
          items: { type: "string" },
          description: "Files modified. Auto-detected from git if omitted.",
        },
        knowledge: {
          type: "object",
          description: "Optional: write a knowledge entry in the same call. Auto-links to the resolved node.",
          properties: {
            key: { type: "string", description: "Knowledge entry key" },
            content: { type: "string", description: "Knowledge content" },
          },
          required: ["key", "content"],
        },
      },
      required: ["node_id", "message"],
    },
  },
];

export async function startServer(): Promise<void> {
  // Set database path — db is created lazily on first tool call
  setDbPath(DB_PATH);

  // [sl:N0IDVJQIhENQFsov6-Lhg] Resolve license tier once at startup (reads license file, doesn't touch db)
  const tier: Tier = getLicenseTier(DB_PATH);

  const server = new Server(
    { name: "graph", version: PKG_VERSION },
    { capabilities: { tools: {}, resources: {} } }
  );

  // Fire-and-forget version check (always-on, single non-blocking fetch)
  checkForUpdate();

  // List tools
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      let result: unknown;

      switch (name) {
        case "graph_open": {
          const openArgs = args as any;
          // Gate: check project limit when creating a new project
          if (openArgs?.project) {
            const { getProjectRoot } = await import("./nodes.js");
            if (!getProjectRoot(openArgs.project)) {
              checkProjectLimit(tier);
            }
          }
          result = handleOpen(openArgs, AGENT_IDENTITY);
          break;
        }

        case "graph_plan": {
          const planArgs = args as any;
          // Gate: check node limit before creating nodes
          if (planArgs?.nodes?.length > 0) {
            // Determine project from the first node's parent
            const { getNode } = await import("./nodes.js");
            const firstParent = planArgs.nodes[0]?.parent_ref;
            if (firstParent && typeof firstParent === "string" && !planArgs.nodes.some((n: any) => n.ref === firstParent)) {
              const parentNode = getNode(firstParent);
              if (parentNode) {
                checkNodeLimit(tier, parentNode.project, planArgs.nodes.length);
              }
            }
          }
          result = handlePlan(planArgs, AGENT_IDENTITY);
          break;
        }

        case "graph_next": {
          const nextArgs = args as any;
          // Gate: strip scope on free tier
          if (nextArgs?.scope) {
            nextArgs.scope = checkScope(tier, nextArgs.scope);
          }
          result = handleNext(nextArgs, AGENT_IDENTITY, CLAIM_TTL);
          break;
        }

        case "graph_context":
          result = handleContext(args as any);
          break;

        case "graph_update":
          result = handleUpdate(args as any, AGENT_IDENTITY);
          break;

        case "graph_connect":
          result = handleConnect(args as any, AGENT_IDENTITY);
          break;

        case "graph_query":
          result = handleQuery(args as any);
          break;

        case "graph_restructure":
          result = handleRestructure(args as any, AGENT_IDENTITY);
          break;

        case "graph_history":
          result = handleHistory(args as any);
          break;

        case "graph_onboard": {
          const onboardArgs = args as any;
          // Gate: cap evidence limit on free tier
          onboardArgs.evidence_limit = capEvidenceLimit(tier, onboardArgs?.evidence_limit);
          result = handleOnboard(onboardArgs);
          break;
        }

        case "graph_tree":
          result = handleTree(args as any);
          break;

        case "graph_status":
          result = handleStatus(args as any);
          break;

        case "graph_agent_config":
          result = handleAgentConfig(PKG_VERSION);
          break;

        case "graph_knowledge_write":
          checkKnowledgeTier(tier);
          result = handleKnowledgeWrite(args as any, AGENT_IDENTITY);
          break;

        case "graph_knowledge_read":
          checkKnowledgeTier(tier);
          result = handleKnowledgeRead(args as any);
          break;

        case "graph_knowledge_delete":
          checkKnowledgeTier(tier);
          result = handleKnowledgeDelete(args as any, AGENT_IDENTITY);
          break;

        case "graph_knowledge_search":
          checkKnowledgeTier(tier);
          result = handleKnowledgeSearch(args as any);
          break;

        case "graph_knowledge_audit":
          checkKnowledgeTier(tier);
          result = handleKnowledgeAudit(args as any);
          break;

        case "graph_retro":
          result = handleRetro(args as any, AGENT_IDENTITY);
          break;

        case "graph_resolve":
          result = handleResolve(args as any, AGENT_IDENTITY);
          break;

        default:
          return {
            content: [
              { type: "text" as const, text: JSON.stringify({ error: `Unknown tool: ${name}` }) },
            ],
            isError: true,
          };
      }

      const content: Array<{ type: "text"; text: string }> = [
        { type: "text" as const, text: JSON.stringify(result, null, 2) },
      ];
      if (versionBanner) {
        const agentNotes = checkAndUpdateAgentFile();
        const bannerParts = [versionBanner, ...agentNotes];
        if (updateWarning) bannerParts.push(updateWarning);
        content.push({ type: "text" as const, text: bannerParts.join("\n") });
        versionBanner = null;
        updateWarning = null;
      }
      return { content };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      const code =
        error instanceof ValidationError
          ? "validation_error"
          : error instanceof EngineError
            ? (error as EngineError).code
            : "error";
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ error: message, code }),
          },
        ],
        isError: true,
      };
    }
  });

  // [sl:Ps3gCuzhMoQWK6tynsGA4] MCP resources — browsable read-only views of graph data

  // Resource templates (dynamic, parameterized URIs)
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: [
      {
        uriTemplate: "graph://{project}/tree",
        name: "Project Tree",
        description: "Full task tree for a project with resolve status",
        mimeType: "application/json",
      },
      {
        uriTemplate: "graph://{project}/knowledge",
        name: "Project Knowledge",
        description: "All knowledge entries for a project",
        mimeType: "application/json",
      },
      {
        uriTemplate: "graph://{project}/knowledge/{key}",
        name: "Knowledge Entry",
        description: "A specific knowledge entry",
        mimeType: "application/json",
      },
    ],
  }));

  // Static resource list (enumerate known projects)
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    try {
      const { listProjects } = await import("./nodes.js");
      const projects = listProjects();
      const resources = projects.flatMap((p) => [
        {
          uri: `graph://${p.project}/tree`,
          name: `${p.project} — Tree`,
          description: `Task tree: ${p.total} nodes (${p.resolved} resolved)`,
          mimeType: "application/json",
        },
        {
          uri: `graph://${p.project}/knowledge`,
          name: `${p.project} — Knowledge`,
          description: `Knowledge entries for ${p.project}`,
          mimeType: "application/json",
        },
      ]);
      return { resources };
    } catch {
      return { resources: [] };
    }
  });

  // Read a specific resource
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;
    const match = uri.match(/^graph:\/\/([^/]+)\/(.+)$/);
    if (!match) {
      throw new Error(`Invalid resource URI: ${uri}`);
    }

    const [, project, path] = match;

    if (path === "tree") {
      const result = handleTree({ project });
      return {
        contents: [{ uri, mimeType: "application/json", text: JSON.stringify(result, null, 2) }],
      };
    }

    if (path === "knowledge") {
      const result = handleKnowledgeRead({ project });
      return {
        contents: [{ uri, mimeType: "application/json", text: JSON.stringify(result, null, 2) }],
      };
    }

    const knowledgeMatch = path.match(/^knowledge\/(.+)$/);
    if (knowledgeMatch) {
      const result = handleKnowledgeRead({ project, key: knowledgeMatch[1] });
      return {
        contents: [{ uri, mimeType: "application/json", text: JSON.stringify(result, null, 2) }],
      };
    }

    throw new Error(`Unknown resource path: ${path}`);
  });

  // Connect transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Periodic WAL checkpoint every 30s — flushes WAL data into main db file
  const checkpointInterval = setInterval(() => {
    try { checkpointDb(); } catch {}
  }, 30_000);

  // Cleanup on exit
  process.on("SIGINT", () => {
    clearInterval(checkpointInterval);
    closeDb();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    clearInterval(checkpointInterval);
    closeDb();
    process.exit(0);
  });
}
