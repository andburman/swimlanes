import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

// [sl:MIVSXp2PYOhrcE28xIFni] npx graph init — auto-write .mcp.json entry

const MCP_CONFIG = {
  command: "npx",
  args: ["-y", "@graph-tl/graph"],
  env: {
    GRAPH_AGENT: "claude-code",
  },
};

export function init(): void {
  const configPath = join(process.cwd(), ".mcp.json");

  let config: Record<string, any> = {};

  if (existsSync(configPath)) {
    try {
      config = JSON.parse(readFileSync(configPath, "utf8"));
    } catch {
      console.error(`Error: ${configPath} exists but is not valid JSON.`);
      process.exit(1);
    }

    if (config.mcpServers?.graph) {
      console.log("Graph is already configured in .mcp.json");
      return;
    }
  }

  if (!config.mcpServers) {
    config.mcpServers = {};
  }

  config.mcpServers.graph = MCP_CONFIG;

  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
  console.log(`Added graph to ${configPath}`);
  console.log("\nRestart Claude Code to load the new MCP server.");
}
