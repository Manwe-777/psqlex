import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listConnections, redactUrl, type Config, type Connection } from "./config.ts";
import { describeIndexes, describeSchema, ping, type ExplainResult, type RunResult } from "./db.ts";
import { ScriptStore } from "./scripts.ts";
import { runAndRecord, statementForExplain, type RunOutcome } from "./runs.ts";
import { planToText } from "./plan-text.ts";
import { RunHistory, SAMPLE_ROWS } from "./history.ts";
import { listVariables } from "../shared/sql.ts";

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const fail = (message: string) => ({ content: [{ type: "text" as const, text: message }], isError: true });

function find(config: Config, id: string): Connection {
  const connections = listConnections(config);
  const match = connections.find((c) => c.id === id) ?? connections.filter((c) => c.project === id)[0];
  if (!match) throw new Error(`Unknown connection "${id}". Call list_connections for valid ids.`);
  return match;
}

// Rows as objects read better for an agent than parallel arrays.
function compact(run: RunResult) {
  return {
    readOnly: run.readOnly,
    durationMs: run.durationMs,
    results: run.results.map((r) => ({
      sql: r.sql,
      command: r.command,
      rowCount: r.rowCount,
      truncated: r.truncated,
      durationMs: r.durationMs,
      columns: r.columns,
      rows: r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c.name, row[i]]))),
    })),
    notices: run.notices.length ? run.notices : undefined,
    ignoredMetaCommands: run.ignoredMetaCommands.length ? run.ignoredMetaCommands : undefined,
    error: run.error,
  };
}

const values = z
  .record(z.string(), z.string())
  .optional()
  .describe("Values for psql variables in the SQL: :name is pasted as-is, :'name' as a quoted literal, :\"name\" as a quoted identifier");

const AGENT_SCRIPT = "agent";

const scriptName = z
  .string()
  .optional()
  .describe(`Script tab to show this in, in the psqlex browser UI. Defaults to "${AGENT_SCRIPT}", which is overwritten each time.`);

export function createMcpServer(getConfig: () => Config, store = new ScriptStore()): McpServer {
  const server = new McpServer({ name: "psqlex", version: "0.1.0" });

  const execute = (connection: Connection, sql: string, kind: "run" | "explain", opts: { values?: Record<string, string>; analyze?: boolean; maxRows?: number; timeoutMs?: number; script: string }) => {
    const config = getConfig();
    return runAndRecord(store, {
      connection,
      sql,
      kind,
      analyze: opts.analyze,
      values: opts.values,
      readOnly: !config.mcp.allowWrites || connection.readOnly,
      maxRows: opts.maxRows ?? config.mcp.maxRows,
      statementTimeoutMs: opts.timeoutMs ?? config.ui.statementTimeoutMs,
      source: "agent",
      script: opts.script,
    });
  };

  const report = (outcome: RunOutcome, format: "text" | "json" = "text") => {
    const historyId = outcome.historyId;
    if (outcome.error) return { ...json({ historyId, error: outcome.error }), isError: true };
    if (outcome.record.kind === "explain") {
      const result = outcome.result as ExplainResult;
      if (format === "json") return json({ historyId, ...result });
      return { content: [{ type: "text" as const, text: `${result.sql}\n\n${planToText(result.plan)}\n\n(history id ${historyId})` }] };
    }
    const run = outcome.result as RunResult;
    return { ...json({ historyId, ...compact(run) }), isError: Boolean(run.error) };
  };

  server.registerTool(
    "list_connections",
    {
      title: "List database connections",
      description:
        "Lists the Postgres connections psqlex knows about, grouped by project. Use the id with the other tools. Set check=true to test each one.",
      inputSchema: { check: z.boolean().optional().describe("Connect to each database and report whether it is up") },
      annotations: { readOnlyHint: true },
    },
    async ({ check }) => {
      const config = getConfig();
      const connections = await Promise.all(
        listConnections(config).map(async (c) => ({
          id: c.id,
          project: c.project,
          name: c.name,
          url: redactUrl(c.url),
          readOnly: c.readOnly || !config.mcp.allowWrites,
          description: c.description,
          status: check ? await ping(c) : undefined,
        })),
      );
      return json(connections);
    },
  );

  server.registerTool(
    "run_sql",
    {
      title: "Run SQL",
      description:
        "Runs SQL (one or more statements, psql \\set lines and :variables allowed) and returns each statement's rows. " +
        `The SQL is saved as a script tab ("${AGENT_SCRIPT}" unless you name one) and the result shows in the psqlex browser UI. ` +
        "Unless writes are enabled in the psqlex config, everything runs in a read-only transaction that is rolled back.",
      inputSchema: {
        connection: z.string().describe("Connection id from list_connections, in the form project/name, e.g. my-app/local"),
        sql: z.string(),
        values,
        script: scriptName,
        maxRows: z.number().int().positive().max(5000).optional().describe("Rows to return per statement"),
        timeoutMs: z.number().int().positive().max(600_000).optional(),
      },
    },
    async ({ connection, sql, values, script, maxRows, timeoutMs }) => {
      try {
        const conn = find(getConfig(), connection);
        const name = script ?? AGENT_SCRIPT;
        store.write(conn.id, name, sql);
        return report(await execute(conn, sql, "run", { values, maxRows, timeoutMs, script: name }));
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  );

  server.registerTool(
    "explain_sql",
    {
      title: "Explain a query",
      description:
        "Returns the query plan for one statement. analyze=true really executes it (inside a transaction that is always rolled back) and adds actual timings and buffers. " +
        `The statement is saved as a script tab ("${AGENT_SCRIPT}" unless you name one) and the plan shows in the psqlex browser UI.`,
      inputSchema: {
        connection: z.string(),
        sql: z.string().describe("Exactly one statement"),
        values,
        analyze: z.boolean().optional(),
        script: scriptName,
        format: z.enum(["text", "json"]).optional().describe("text (default) is close to psql's layout"),
        timeoutMs: z.number().int().positive().max(600_000).optional(),
      },
    },
    async ({ connection, sql, values, analyze, script, format, timeoutMs }) => {
      try {
        const conn = find(getConfig(), connection);
        const name = script ?? AGENT_SCRIPT;
        store.write(conn.id, name, sql);
        return report(await execute(conn, sql, "explain", { values, analyze, timeoutMs, script: name }), format);
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  );

  server.registerTool(
    "list_scripts",
    {
      title: "List scripts",
      description:
        "Lists the saved SQL scripts of a connection. Each one is a tab in the psqlex browser UI, where the user watches edits and runs live.",
      inputSchema: { connection: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ connection }) => {
      try {
        const conn = find(getConfig(), connection);
        return json(store.list(conn.id).map(({ name, version, updatedAt, size }) => ({ name, version, updatedAt, size })));
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  );

  server.registerTool(
    "read_script",
    {
      title: "Read a script",
      description: "Returns a script's SQL, its version, and its last run (who ran it, when, and any error).",
      inputSchema: { connection: z.string(), name: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ connection, name }) => {
      try {
        const conn = find(getConfig(), connection);
        const script = store.read(conn.id, name);
        const last = store.lastRun(conn.id, name);
        return json({
          name: script.name,
          version: script.version,
          content: script.content,
          lastRun: last && { source: last.source, kind: last.kind, at: last.at, error: last.error ?? (last.result as RunResult | undefined)?.error },
        });
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  );

  server.registerTool(
    "write_script",
    {
      title: "Write a script",
      description: "Creates a script or replaces its whole SQL. The user sees the change in the browser right away.",
      inputSchema: {
        connection: z.string(),
        name: z.string().describe("Letters, digits, spaces, _ . - (no .sql needed)"),
        content: z.string(),
        baseVersion: z.string().optional().describe("Version from read_script; the write fails if the script changed since"),
      },
    },
    async ({ connection, name, content, baseVersion }) => {
      try {
        const conn = find(getConfig(), connection);
        const { version } = store.write(conn.id, name, content, baseVersion);
        return json({ name, version });
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  );

  server.registerTool(
    "edit_script",
    {
      title: "Edit a script",
      description: "Replaces one exact, unique piece of a script's SQL. The user sees the change in the browser right away.",
      inputSchema: {
        connection: z.string(),
        name: z.string(),
        oldText: z.string().describe("Text to replace; must appear exactly once"),
        newText: z.string(),
      },
    },
    async ({ connection, name, oldText, newText }) => {
      try {
        const conn = find(getConfig(), connection);
        const { version, content } = store.edit(conn.id, name, oldText, newText);
        return json({ name, version, content });
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  );

  server.registerTool(
    "run_script",
    {
      title: "Run a script",
      description:
        "Runs a saved script, or explains one of its statements, and shows the result in its browser tab. " +
        "mode=run runs every statement; explain and analyze plan one statement (pass statement when the script has several).",
      inputSchema: {
        connection: z.string(),
        name: z.string(),
        mode: z.enum(["run", "explain", "analyze"]).optional(),
        statement: z.number().int().positive().optional().describe("1-based statement number, for explain and analyze"),
        values,
        format: z.enum(["text", "json"]).optional().describe("Plan format for explain and analyze"),
        maxRows: z.number().int().positive().max(5000).optional(),
        timeoutMs: z.number().int().positive().max(600_000).optional(),
      },
    },
    async ({ connection, name, mode, statement, values, format, maxRows, timeoutMs }) => {
      try {
        const conn = find(getConfig(), connection);
        const { content } = store.read(conn.id, name);
        if ((mode ?? "run") === "run") return report(await execute(conn, content, "run", { values, maxRows, timeoutMs, script: name }));
        const sql = statementForExplain(content, statement);
        return report(await execute(conn, sql, "explain", { values, analyze: mode === "analyze", timeoutMs, script: name }), format);
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  );

  server.registerTool(
    "list_runs",
    {
      title: "List past runs",
      description:
        "Lists earlier runs, newest first: from the psqlex page and from agents, kept for 30 days. Each has an id for get_run, " +
        "whether it failed and the error message. Use it to find what ran before and why it failed.",
      inputSchema: {
        connection: z.string().optional().describe("Only this connection"),
        script: z.string().optional().describe("Only runs of this script tab"),
        source: z.enum(["ui", "agent"]).optional().describe("ui = run by the user from the page"),
        failedOnly: z.boolean().optional(),
        since: z.string().optional().describe("ISO date or timestamp"),
        limit: z.number().int().positive().max(200).optional().describe("Default 20"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ connection, script, source, failedOnly, since, limit }) => {
      try {
        const id = connection ? find(getConfig(), connection).id : undefined;
        return json(new RunHistory(store.root).list({ connection: id, script, source, failedOnly, since, limit }));
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  );

  server.registerTool(
    "get_run",
    {
      title: "Get a past run",
      description:
        "Returns one earlier run in full: the SQL as sent (after variable substitution) and the values used, each statement's " +
        `command, row count, timing and first ${SAMPLE_ROWS} rows, notices, the plan for explains, and the complete error with its code, position and failing statement.`,
      inputSchema: { id: z.string().describe("Id from list_runs, or historyId from a run") },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      const entry = new RunHistory(store.root).get(id);
      return entry ? json(entry) : fail(`No run with id ${id}`);
    },
  );

  server.registerTool(
    "list_tables",
    {
      title: "List tables",
      description: "Lists tables, views and materialized views with estimated row counts.",
      inputSchema: { connection: z.string(), schema: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ connection, schema }) => {
      try {
        const tables = await describeSchema(find(getConfig(), connection), schema);
        return json(tables.map(({ columns, ...t }) => ({ ...t, columns: columns.length })));
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  );

  server.registerTool(
    "describe_table",
    {
      title: "Describe a table",
      description: "Returns a table's columns (type, nullability, default) and index definitions.",
      inputSchema: { connection: z.string(), table: z.string(), schema: z.string().optional().describe("Defaults to public") },
      annotations: { readOnlyHint: true },
    },
    async ({ connection, table, schema }) => {
      try {
        const conn = find(getConfig(), connection);
        const [match] = await describeSchema(conn, schema ?? "public", table);
        if (!match) return fail(`No table ${schema ?? "public"}.${table}`);
        return json({ ...match, indexes: await describeIndexes(conn, match.schema, match.name) });
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  );

  server.registerTool(
    "script_variables",
    {
      title: "List script variables",
      description: "Lists the psql variables a script uses, with the default from any \\set line, so you know which values to pass.",
      inputSchema: { sql: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ sql }) => json(listVariables(sql)),
  );

  return server;
}
