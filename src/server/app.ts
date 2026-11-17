import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { serveStatic } from "@hono/node-server/serve-static";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { z } from "zod";
import {
  appRoot,
  configPath,
  editableProjects,
  listConnections,
  redactUrl,
  resolveEditedUrl,
  saveProjects,
  writableConfigPath,
  type Config,
  type EditableProject,
} from "./config.ts";
import { cancel, describeSchema, ping, ScriptError } from "./db.ts";
import { ScriptError as StoreError, ScriptStore, type StoreEvent } from "./scripts.ts";
import { runAndRecord } from "./runs.ts";
import { createMcpServer } from "./mcp.ts";
import { listVariables } from "../shared/sql.ts";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
// *.localhost always resolves to this machine (RFC 6761), e.g. psqlex.localhost.
const isLocalHost = (host: string) => LOCAL_HOSTS.has(host) || host.endsWith(".localhost");

export function createApp(getConfig: () => Config, opts: { token?: string; store?: ScriptStore } = {}) {
  const app = new Hono();
  const store = opts.store ?? new ScriptStore();

  // Every change to a script or its last run, whoever made it (browser, MCP
  // over HTTP or stdio, an editor), reaches the browsers through this watcher.
  const listeners = new Set<(event: StoreEvent) => void>();
  store.watch((event) => listeners.forEach((send) => send(event)));

  // psqlex can write to databases and has no login, so it only answers
  // requests addressed to this machine (blocks DNS-rebinding pages) and, when
  // PSQLEX_TOKEN is set, only requests carrying that token.
  app.use("*", async (c, next) => {
    const host = (c.req.header("host") ?? "").replace(/:\d+$/, "");
    if (!opts.token && !isLocalHost(host)) return c.text("Forbidden host", 403);
    if (opts.token && (c.req.path.startsWith("/api") || c.req.path.startsWith("/mcp"))) {
      const auth = c.req.header("authorization");
      const given = auth?.replace(/^Bearer /i, "") ?? c.req.query("token");
      if (given !== opts.token) return c.text("Unauthorized", 401);
    }
    await next();
  });

  const connection = (id: string) => {
    const conn = listConnections(getConfig()).find((c) => c.id === id);
    if (!conn) throw new ScriptError(`Unknown connection ${id}`);
    return conn;
  };

  app.onError((err, c) => {
    const queryError = (err as { queryError?: unknown }).queryError;
    if (queryError) return c.json({ error: queryError }, 400);
    if (err instanceof StoreError) {
      const current = (err as { current?: unknown }).current;
      return c.json({ error: { message: err.message }, current }, err.status as 400 | 404 | 409);
    }
    const status = err instanceof ScriptError ? 400 : 500;
    return c.json({ error: { message: err.message || String(err) } }, status);
  });

  app.get("/api/connections", (c) => {
    const config = getConfig();
    return c.json({
      connections: listConnections(config).map((conn) => ({ ...conn, url: redactUrl(conn.url) })),
      ui: config.ui,
    });
  });

  app.get("/api/config", (c) =>
    c.json({ projects: editableProjects(getConfig()), readFrom: configPath(), writesTo: writableConfigPath() }),
  );

  app.put("/api/config", async (c) => {
    const { projects } = await c.req.json<{ projects: EditableProject[] }>();
    try {
      const saved = saveProjects(projects, getConfig());
      for (const p of projects) {
        for (const conn of p.connections) {
          if (conn.originalId) store.moveConnection(conn.originalId, `${p.name.trim()}/${conn.name.trim()}`);
        }
      }
      return c.json({ projects: editableProjects(saved), readFrom: configPath(), writesTo: writableConfigPath() });
    } catch (err) {
      if (err instanceof z.ZodError) {
        const message = err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
        return c.json({ error: { message } }, 400);
      }
      throw err;
    }
  });

  // Tests a URL from the connection editor before it is saved.
  app.post("/api/test-connection", async (c) => {
    const body = await c.req.json<{ url: string; originalId?: string; name?: string }>();
    const url = resolveEditedUrl(getConfig(), { name: body.name ?? "test", url: body.url, originalId: body.originalId });
    return c.json(await ping({ id: "test", project: "test", name: "test", url, readOnly: true }));
  });

  app.get("/api/connections/:id{.+}/ping", async (c) => c.json(await ping(connection(c.req.param("id")))));

  app.get("/api/connections/:id{.+}/schema", async (c) => c.json(await describeSchema(connection(c.req.param("id")))));

  type RunBody = {
    connection: string;
    sql: string;
    values?: Record<string, string>;
    runId?: string;
    readOnly?: boolean;
    analyze?: boolean;
    script?: string;
  };

  const runFromUi = async (body: RunBody, kind: "run" | "explain") => {
    const ui = getConfig().ui;
    const conn = connection(body.connection);
    return runAndRecord(store, {
      connection: conn,
      sql: body.sql,
      kind,
      analyze: body.analyze,
      values: body.values,
      readOnly: Boolean(body.readOnly || conn.readOnly),
      maxRows: ui.maxRows,
      statementTimeoutMs: ui.statementTimeoutMs,
      runId: body.runId,
      source: "ui",
      script: body.script,
    });
  };

  app.post("/api/run", async (c) => {
    const outcome = await runFromUi(await c.req.json<RunBody>(), "run");
    if (outcome.error) return c.json({ error: outcome.error }, 400);
    return c.json(outcome.result);
  });

  app.post("/api/explain", async (c) => {
    const outcome = await runFromUi(await c.req.json<RunBody>(), "explain");
    if (outcome.error) return c.json({ error: outcome.error }, 400);
    return c.json(outcome.result);
  });

  app.get("/api/scripts/:project/:name", (c) => {
    const id = `${c.req.param("project")}/${c.req.param("name")}`;
    connection(id);
    return c.json(store.list(id).map((info) => ({ ...info, lastRun: store.lastRun(id, info.name) })));
  });

  app.get("/api/scripts/:project/:name/:script", (c) => {
    const id = `${c.req.param("project")}/${c.req.param("name")}`;
    return c.json({ ...store.read(id, c.req.param("script")), lastRun: store.lastRun(id, c.req.param("script")) });
  });

  // Creates or replaces a script. baseVersion guards against overwriting a
  // change made elsewhere since the browser last saw the script (409).
  app.put("/api/scripts/:project/:name/:script", async (c) => {
    const id = `${c.req.param("project")}/${c.req.param("name")}`;
    connection(id);
    const body = await c.req.json<{ content: string; baseVersion?: string; create?: boolean }>();
    if (body.create && store.exists(id, c.req.param("script"))) {
      return c.json({ error: { message: `A script named "${c.req.param("script")}" already exists` } }, 409);
    }
    return c.json(store.write(id, c.req.param("script"), body.content, body.baseVersion));
  });

  app.post("/api/scripts/:project/:name/:script/rename", async (c) => {
    const id = `${c.req.param("project")}/${c.req.param("name")}`;
    const { to } = await c.req.json<{ to: string }>();
    return c.json(store.rename(id, c.req.param("script"), to));
  });

  app.delete("/api/scripts/:project/:name/:script", (c) => {
    store.remove(`${c.req.param("project")}/${c.req.param("name")}`, c.req.param("script"));
    return c.json({ deleted: true });
  });

  app.get("/api/events", (c) =>
    streamSSE(c, async (stream) => {
      const send = (event: StoreEvent) => void stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
      listeners.add(send);
      stream.onAbort(() => void listeners.delete(send));
      await stream.writeSSE({ event: "ready", data: "{}" });
      while (!stream.aborted) {
        await stream.sleep(20_000);
        await stream.writeSSE({ event: "ping", data: "{}" });
      }
    }),
  );

  app.post("/api/cancel/:runId", async (c) => c.json({ cancelled: await cancel(c.req.param("runId")) }));

  app.post("/api/variables", async (c) => {
    const { sql } = await c.req.json<{ sql: string }>();
    return c.json(listVariables(sql));
  });

  // Stateless MCP over Streamable HTTP: a fresh server per request.
  app.all("/mcp", async (c) => {
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const server = createMcpServer(getConfig, store);
    await server.connect(transport);
    return transport.handleRequest(c.req.raw);
  });

  const webRoot = join(appRoot(), "dist/web");
  if (existsSync(webRoot)) {
    const root = relative(process.cwd(), webRoot);
    app.use("/*", serveStatic({ root }));
    app.get("*", serveStatic({ root, path: "index.html" }));
  }

  return app;
}
