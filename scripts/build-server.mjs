// Bundles the server and its dependencies into one file, so a release needs
// only Node.js and no node_modules.
import { build } from "esbuild";

await build({
  entryPoints: ["src/server/cli.ts"],
  outfile: "dist/psqlex.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  external: ["pg-native"],
  // CommonJS dependencies (pg) call require() on Node built-ins.
  banner: { js: "import { createRequire as __psqlexRequire } from 'node:module'; const require = __psqlexRequire(import.meta.url);" },
  legalComments: "none",
});
