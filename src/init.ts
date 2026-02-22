import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { handleAgentConfig } from "./tools/agent-config.js";

// [sl:hy8oXisWnrZN1BfkonUqd] npx @graph-tl/graph init — zero friction onboarding

let PKG_VERSION = "0.0.0";
try {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));
  PKG_VERSION = pkg.version;
} catch {}

const MCP_CONFIG = {
  command: "npx",
  args: ["-y", "@graph-tl/graph"],
  env: {
    GRAPH_AGENT: "claude-code",
  },
};

export function init(): void {
  const cwd = process.cwd();
  let wrote = false;

  // 1. Write .mcp.json
  const configPath = join(cwd, ".mcp.json");
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, "utf8"));
      if (config.mcpServers?.graph) {
        console.log("✓ .mcp.json — graph already configured");
      } else {
        config.mcpServers = config.mcpServers ?? {};
        config.mcpServers.graph = MCP_CONFIG;
        writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
        console.log("✓ .mcp.json — added graph server");
        wrote = true;
      }
    } catch {
      console.error(`✗ .mcp.json exists but is not valid JSON — skipping`);
    }
  } else {
    const config = { mcpServers: { graph: MCP_CONFIG } };
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
    console.log("✓ .mcp.json — created with graph server");
    wrote = true;
  }

  // 2. Write .claude/agents/graph.md
  const agentPath = join(cwd, ".claude", "agents", "graph.md");
  const { agent_file } = handleAgentConfig(PKG_VERSION);
  if (existsSync(agentPath)) {
    const current = readFileSync(agentPath, "utf8");
    if (current === agent_file) {
      console.log("✓ .claude/agents/graph.md — already up to date");
    } else {
      writeFileSync(agentPath, agent_file, "utf8");
      console.log("✓ .claude/agents/graph.md — updated");
      wrote = true;
    }
  } else {
    mkdirSync(dirname(agentPath), { recursive: true });
    writeFileSync(agentPath, agent_file, "utf8");
    console.log("✓ .claude/agents/graph.md — created graph workflow agent");
    wrote = true;
  }

  // 3. Append graph workflow instructions to CLAUDE.md
  // [sl:qPxNQTKru6q3nPzsNWlfe] Ensure default agent follows graph workflow
  const claudeMdPath = join(cwd, "CLAUDE.md");
  const graphSection = `
## Graph workflow

This project uses Graph for task tracking across sessions.

**Every session:** Start with \`graph_onboard\` to see project state, actionable tasks, and continuity confidence.

**Claim-work-resolve loop:** \`graph_next\` (claim) → do work → \`graph_update\` (resolve with evidence). Never execute ad-hoc work — add it to the graph first via \`graph_plan\`.

**Key rules:**
- **Knowledge first.** When you need project context (design decisions, conventions, architecture), check \`graph_knowledge_read\` before searching files or git. Graph knowledge is written by previous sessions specifically for you.
- **Always resolve with evidence.** Committing code is not enough — call \`graph_update\` with evidence (what changed, why, test results). The next agent depends on this.
- **Pause after each task.** Show status with \`graph_status\`, then wait for the user. Don't auto-continue to the next task.
- **Record what you notice.** Bugs, tech debt, ideas found while working — add them as nodes via \`graph_plan\`. If it's not in the graph, it's forgotten.
- **Write knowledge for the next session.** When you learn something reusable (environment setup, conventions, gotchas), write it with \`graph_knowledge_write\`.
- **Retro after significant work.** Reflect on friction, missed context, and repeated mistakes. Identify behavioral patterns that should become CLAUDE.md instructions — these are the highest-value findings because they improve every future session.
`;

  if (existsSync(claudeMdPath)) {
    const current = readFileSync(claudeMdPath, "utf8");
    if (current.includes("Graph workflow") || current.includes("graph_onboard")) {
      console.log("✓ CLAUDE.md — graph workflow instructions already present");
    } else {
      appendFileSync(claudeMdPath, graphSection, "utf8");
      console.log("✓ CLAUDE.md — appended graph workflow instructions");
      wrote = true;
    }
  } else {
    const newClaudeMd = `# CLAUDE.md
${graphSection}`;
    writeFileSync(claudeMdPath, newClaudeMd, "utf8");
    console.log("✓ CLAUDE.md — created with graph workflow instructions");
    wrote = true;
  }

  // 4. Summary
  console.log("");
  if (wrote) {
    console.log("Graph is ready. Restart Claude Code to load the MCP server.");
    console.log("");
    console.log("Then try:");
    console.log('  "Use graph to plan building a REST API with auth and tests."');
  } else {
    console.log("Graph is already set up — nothing to do.");
  }
}
