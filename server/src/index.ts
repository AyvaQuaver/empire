import { config } from "./config.js";
import { createApp } from "./app.js";

async function main(): Promise<void> {
  const handle = createApp();
  const port = await handle.listen();
  console.log(`[empire] API listening on http://localhost:${port} (env: ${config.nodeEnv})`);
  const shutdown = async () => {
    console.log("\n[empire] shutting down…");
    await handle.close(); // closes both server and db
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[empire] failed to start:", err);
  process.exit(1);
});
