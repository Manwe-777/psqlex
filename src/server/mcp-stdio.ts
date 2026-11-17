import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { configPath, loadConfig } from "./config.ts";
import { createMcpServer } from "./mcp.ts";

await createMcpServer(() => loadConfig(configPath())).connect(new StdioServerTransport());
