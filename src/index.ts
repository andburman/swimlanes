import { startServer } from "./server.js";

startServer().catch((error) => {
  console.error("Failed to start swimlanes:", error);
  process.exit(1);
});
