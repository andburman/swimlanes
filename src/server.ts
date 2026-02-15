import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { initDb, closeDb } from "./db.js";
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

// Config from env
const AGENT_IDENTITY = process.env.GRAPH_AGENT ?? "default-agent";
const DB_PATH = process.env.GRAPH_DB ?? "./graph.db";
const CLAIM_TTL = parseInt(process.env.GRAPH_CLAIM_TTL ?? "60", 10);

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
      "Update one or more nodes. Can change resolved, state, summary, properties (merged), context_links, and add evidence. When resolving nodes, returns newly_actionable — nodes that became unblocked. ENFORCED: Resolving a node requires evidence — the engine rejects resolved=true if the node has no existing evidence and no add_evidence in the call. Include at least one add_evidence entry (type: 'git' for commits, 'note' for what was done and why, 'test' for results). Also add context_links to files you modified.",
    inputSchema: {
      type: "object" as const,
      properties: {
        updates: {
          type: "array",
          items: {
            type: "object",
            properties: {
              node_id: { type: "string" },
              resolved: { type: "boolean" },
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
      "Modify graph structure: move (reparent), merge (combine two nodes), drop (resolve node + subtree with reason). Atomic. Reports newly_actionable nodes.",
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
                enum: ["move", "merge", "drop"],
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
];

export async function startServer(): Promise<void> {
  // Init database
  initDb(DB_PATH);

  const server = new Server(
    { name: "graph", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

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
        case "graph_open":
          result = handleOpen(args as any, AGENT_IDENTITY);
          break;

        case "graph_plan":
          result = handlePlan(args as any, AGENT_IDENTITY);
          break;

        case "graph_next":
          result = handleNext(args as any, AGENT_IDENTITY, CLAIM_TTL);
          break;

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

        default:
          return {
            content: [
              { type: "text" as const, text: JSON.stringify({ error: `Unknown tool: ${name}` }) },
            ],
            isError: true,
          };
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
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

  // Connect transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Cleanup on exit
  process.on("SIGINT", () => {
    closeDb();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    closeDb();
    process.exit(0);
  });
}
