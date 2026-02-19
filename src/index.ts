// [sl:WvU_sWubakQWRCkP993pp] CLI routing — activate subcommand or MCP server
export {};

const args = process.argv.slice(2);

if (args[0] === "activate") {
  const { activate } = await import("./activate.js");
  activate(args[1]);
} else if (args[0] === "init") {
  const { init } = await import("./init.js");
  init();
} else {
  const { startServer } = await import("./server.js");
  startServer().catch((error) => {
    console.error("Failed to start graph:", error);
    process.exit(1);
  });
}
