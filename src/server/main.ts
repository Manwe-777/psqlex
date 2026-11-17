import { serve } from "@hono/node-server";
import { configPath, loadConfig } from "./config.ts";
import { createApp } from "./app.ts";

const port = Number(process.env.PSQLEX_PORT ?? 7457);
const hostname = process.env.PSQLEX_HOST ?? "127.0.0.1";
const token = process.env.PSQLEX_TOKEN || undefined;

if (hostname !== "127.0.0.1" && hostname !== "localhost" && !token) {
  console.error(`Refusing to listen on ${hostname} without PSQLEX_TOKEN set.`);
  process.exit(1);
}

// Read on every request so config edits apply without a restart.
const getConfig = () => loadConfig(configPath());
getConfig();

serve({ fetch: createApp(getConfig, { token }).fetch, port, hostname }, () => {
  const shown = hostname === "127.0.0.1" || hostname === "localhost" ? "psqlex.localhost" : hostname;
  console.log(`psqlex on http://${shown}:${port}  (MCP: http://127.0.0.1:${port}/mcp)`);
  console.log(`config: ${configPath()}`);
});
