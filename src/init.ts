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

This project uses Graph for task tracking across sessions. Start every session with \`graph_onboard\` to see project state, actionable tasks, and continuity confidence. Follow the claim-work-resolve loop: \`graph_next\` (claim) → do work → \`graph_update\` (resolve with evidence). Don't execute ad-hoc work — add it to the graph first via \`graph_plan\`.
`;

  if (existsSync(claudeMdPath)) {
    const current = readFileSync(claudeMdPath, "utf8");
    if (current.includes("graph_onboard")) {
      console.log("✓ CLAUDE.md — graph workflow instructions already present");
    } else {
      appendFileSync(claudeMdPath, graphSection, "utf8");
      console.log("✓ CLAUDE.md — appended graph workflow instructions");
      wrote = true;
    }
  } else {
    writeFileSync(claudeMdPath, `# CLAUDE.md\n\nThis file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.\n${graphSection}`, "utf8");
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
