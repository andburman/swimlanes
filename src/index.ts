// [sl:WvU_sWubakQWRCkP993pp] CLI routing — activate subcommand or MCP server
export {};

import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

let PKG_VERSION = "0.0.0";
try {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));
  PKG_VERSION = pkg.version;
} catch {}

const args = process.argv.slice(2);

// --version / -v
if (args[0] === "--version" || args[0] === "-v") {
  console.log(`@graph-tl/graph ${PKG_VERSION}`);
  process.exit(0);
}

// --help / -h
if (args[0] === "--help" || args[0] === "-h") {
  console.log(`@graph-tl/graph v${PKG_VERSION}

Usage: graph <command>

Commands:
  init           Set up graph in the current project (.mcp.json, agent file, CLAUDE.md)
  update         Clear npx cache and re-run init to get the latest version
  ship           Build, test, bump, commit, push, and create GitHub release
  activate       Activate a license key
  backup         List, create, or restore database backups
  ui             Start the graph web UI

Flags:
  --version, -v  Print version
  --help, -h     Print this help message

Without a command, starts the MCP server (used by Claude Code).`);
  process.exit(0);
}

if (args[0] === "activate") {
  const { activate } = await import("./activate.js");
  activate(args[1]);
} else if (args[0] === "init") {
  const { init } = await import("./init.js");
  init();
} else if (args[0] === "update") {
  const { execSync } = await import("child_process");
  console.log("Clearing npx cache...");
  try {
    execSync("npx clear-npx-cache", { stdio: "inherit" });
  } catch {
    // clear-npx-cache may not be available; continue anyway
  }
  console.log("");
  const { init } = await import("./init.js");
  init();
  console.log("");
  console.log("Updated. Restart Claude Code to load the new version.");
} else if (args[0] === "ship") {
  const { execSync } = await import("child_process");
  const { readFileSync: readFs, writeFileSync: writeFs } = await import("fs");
  const { join: joinPath, dirname: dirnamePath } = await import("path");
  const { fileURLToPath: fileUrl } = await import("url");

  const run = (cmd: string) => execSync(cmd, { stdio: "inherit", encoding: "utf-8" });

  // 1. Build
  console.log("Building...");
  run("npm run build");

  // 2. Test
  console.log("\nRunning tests...");
  run("npm test");

  // 3. Bump patch version
  const pkgPath = joinPath(dirnamePath(fileUrl(import.meta.url)), "..", "package.json");
  const pkg = JSON.parse(readFs(pkgPath, "utf-8"));
  const [major, minor, patch] = pkg.version.split(".").map(Number);
  const newVersion = `${major}.${minor}.${patch + 1}`;
  pkg.version = newVersion;
  writeFs(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf-8");
  console.log(`\nBumped version: ${major}.${minor}.${patch} → ${newVersion}`);

  // 4. Rebuild with new version
  run("npm run build");

  // 5. Commit and push
  console.log("\nCommitting and pushing...");
  run("git add -A");
  run(`git commit -m "Bump to ${newVersion}"`);
  run("git push");

  // 6. Generate release notes from commits since last tag
  let notes = "";
  try {
    const lastTag = execSync("git describe --tags --abbrev=0 HEAD~1", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
    notes = execSync(`git log --oneline ${lastTag}..HEAD~1`, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch {
    // No previous tag — use last 10 commits
    notes = execSync("git log --oneline -10 HEAD~1", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  }

  const releaseBody = notes
    .split("\n")
    .map((line: string) => `- ${line.slice(line.indexOf(" ") + 1)}`)
    .join("\n");

  // 7. Create GitHub release
  console.log(`\nCreating GitHub release v${newVersion}...`);
  execSync(
    `gh release create v${newVersion} --target main --title "v${newVersion}" --notes "${releaseBody.replace(/"/g, '\\"')}"`,
    { stdio: "inherit" }
  );

  console.log(`\n✓ Shipped v${newVersion}`);
} else if (args[0] === "backup") {
  const { setDbPath, resolveDbPath, initDb, backupDb, listBackups, restoreDb } = await import("./db.js");
  const dbp = resolveDbPath();
  setDbPath(dbp);

  const sub = args[1];
  if (sub === "create") {
    initDb();
    const dest = backupDb("manual");
    if (dest) {
      console.log(`✓ Backup created: ${dest}`);
    } else {
      console.log("✗ No database found to backup");
    }
  } else if (sub === "restore") {
    const target = args[2];
    if (!target) {
      console.error("Usage: graph backup restore <filename|number>");
      console.error("  number: 1 = most recent, 2 = second most recent, etc.");
      process.exit(1);
    }
    const restored = restoreDb(target);
    console.log(`✓ Restored from ${restored}`);
    console.log("  Restart Claude Code to use the restored database.");
  } else {
    // Default: list backups
    const backups = listBackups();
    if (backups.length === 0) {
      console.log("No backups found.");
      console.log("Backups are created automatically on daily startup and before schema migrations.");
      console.log("");
      console.log("Manual backup: graph backup create");
    } else {
      console.log(`Backups (${backups.length}):\n`);
      backups.forEach((b, i) => {
        const sizeKb = Math.round(b.size / 1024);
        console.log(`  ${i + 1}. ${b.filename}  ${sizeKb}KB  [${b.tag}]`);
      });
      console.log("");
      console.log("Restore:  graph backup restore <number>");
      console.log("Create:   graph backup create");
    }
  }
} else if (args[0] === "ui") {
  const { startUi } = await import("./ui.js");
  startUi(args.slice(1));
} else {
  const { startServer } = await import("./server.js");
  startServer().catch((error) => {
    console.error("Failed to start graph:", error);
    process.exit(1);
  });
}
