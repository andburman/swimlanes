import { startServer } from "./server.js";

startServer().catch((error) => {
  console.error("Failed to start graph:", error);
  process.exit(1);
});
