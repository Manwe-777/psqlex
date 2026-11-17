import { configPath } from "./config.ts";

const command = process.argv[2] ?? "serve";

if (command === "serve") await import("./main.ts");
else if (command === "mcp") await import("./mcp-stdio.ts");
else if (command === "config-path") console.log(configPath());
else {
  console.error(`Unknown command "${command}". Use serve, mcp or config-path.`);
  process.exit(2);
}
