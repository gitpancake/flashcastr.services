import "./instrumentation.js";

const { startApi } = await import("./server.js");
const { createLogger } = await import("@flashcastr/logger");

startApi().catch((err) => {
  createLogger("api").error("Failed to start API:", err);
  process.exit(1);
});
