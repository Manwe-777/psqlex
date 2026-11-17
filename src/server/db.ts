import pg from "pg";
import Cursor from "pg-cursor";
import { randomUUID } from "node:crypto";
import { checkConnectionUrl, connectionAttempts, interpolateEnv, type Connection } from "./config.ts";
import { prepareScript } from "../shared/sql.ts";

// Every value comes back as the text Postgres sends, the way psql shows it.
// This keeps timestamps, numerics and bigints exact.
const textTypes = { getTypeParser: () => (value: string) => value };

export interface Column {
  name: string;
  type: string;
}

export interface StatementResult {
  sql: string;
  command: string | null;
  rowCount: number | null;
  columns: Column[];
  rows: (string | null)[][];
  truncated: boolean;
  durationMs: number;
}

export interface QueryError {
  message: string;
  code?: string;
  detail?: string;
  hint?: string;
  position?: number;
  statementIndex?: number;
  sql?: string;
}

export interface RunResult {
  runId: string;
  results: StatementResult[];
  notices: string[];
  ignoredMetaCommands: string[];
  error?: QueryError;
  durationMs: number;
  readOnly: boolean;
}

export interface RunOptions {
  values?: Record<string, string>;
  maxRows?: number;
  statementTimeoutMs?: number;
  readOnly?: boolean;
  runId?: string;
}

const running = new Map<string, { pid: number; connection: Connection }>();

async function connect(connection: Connection): Promise<pg.Client> {
  const url = interpolateEnv(connection.url);
  checkConnectionUrl(url);
  const attempts = connectionAttempts(url);
  for (const [i, attempt] of attempts.entries()) {
    const client = new pg.Client({
      connectionString: attempt,
      types: textTypes,
      application_name: "psqlex",
      connectionTimeoutMillis: 5000,
    });
    // Without a listener, a socket error that arrives after a connect timeout
    // or between queries is an uncaught 'error' event and kills the server.
    client.on("error", (err) => console.error(`[psqlex] ${connection.id}: ${err.message}`));
    try {
      await client.connect();
      return client;
    } catch (err) {
      const last = i === attempts.length - 1;
      if (last || !/does not support SSL/i.test((err as Error).message)) throw err;
    }
  }
  throw new Error("unreachable");
}

export class ScriptError extends Error {}

// Statements that would end or reconfigure the read-only transaction that
// read-only runs are wrapped in.
const TRANSACTION_CONTROL =
  /^(begin|start|commit|end|rollback|abort|prepare\s+transaction|commit\s+prepared|rollback\s+prepared|set\s+(session\s+characteristics|transaction|(session\s+|local\s+)?(default_)?transaction_read_only)|reset\s+(all|(default_)?transaction_read_only)|discard)\b/i;

export function stripLeadingComments(sql: string): string {
  let s = sql.trimStart();
  for (;;) {
    if (s.startsWith("--")) {
      const nl = s.indexOf("\n");
      s = nl === -1 ? "" : s.slice(nl + 1).trimStart();
    } else if (s.startsWith("/*")) {
      const close = s.indexOf("*/");
      s = close === -1 ? "" : s.slice(close + 2).trimStart();
    } else return s;
  }
}

export function isTransactionControl(sql: string): boolean {
  return TRANSACTION_CONTROL.test(stripLeadingComments(sql));
}

function toQueryError(err: unknown, statementIndex?: number, sql?: string): QueryError {
  const e = err as pg.DatabaseError;
  return {
    message: e.message ?? String(err),
    code: e.code,
    detail: e.detail,
    hint: e.hint,
    position: e.position ? Number(e.position) : undefined,
    statementIndex,
    sql,
  };
}

async function typeNames(client: pg.Client, oids: number[]): Promise<Map<number, string>> {
  if (oids.length === 0) return new Map();
  const res = await client.query<{ oid: string; name: string }>(
    "select oid::text, format_type(oid, null) as name from pg_type where oid = any($1::oid[])",
    [oids],
  );
  return new Map(res.rows.map((r) => [Number(r.oid), r.name]));
}

async function runStatement(client: pg.Client, sql: string, maxRows: number): Promise<StatementResult> {
  const started = performance.now();
  const cursor = client.query(new Cursor(sql, [], { rowMode: "array" }));
  try {
    const rows = (await cursor.read(maxRows + 1)) as (string | null)[][];
    const truncated = rows.length > maxRows;
    if (truncated) rows.length = maxRows;
    const result = (cursor as unknown as { _result: pg.QueryResult })._result;
    return {
      sql,
      command: result.command ?? (result.fields.length ? "SELECT" : null),
      rowCount: truncated ? null : (result.rowCount ?? (result.fields.length ? rows.length : null)),
      columns: result.fields.map((f) => ({ name: f.name, type: String(f.dataTypeID) })),
      rows,
      truncated,
      durationMs: Math.round((performance.now() - started) * 100) / 100,
    };
  } finally {
    await cursor.close();
  }
}

export async function runScript(connection: Connection, script: string, opts: RunOptions = {}): Promise<RunResult> {
  const prepared = prepareScript(script, opts.values ?? {});
  if (prepared.missing.length) {
    throw new ScriptError(`No value for variable(s): ${prepared.missing.join(", ")}`);
  }
  if (prepared.statements.length === 0) throw new ScriptError("Nothing to run");
  const readOnly = Boolean(opts.readOnly || connection.readOnly);
  if (readOnly) {
    const bad = prepared.statements.find(isTransactionControl);
    if (bad) throw new ScriptError(`Transaction control is not allowed in read-only mode: ${bad.slice(0, 80)}`);
  }

  const runId = opts.runId ?? randomUUID();
  const maxRows = opts.maxRows ?? 1000;
  const started = performance.now();
  const results: StatementResult[] = [];
  const notices: string[] = [];
  let error: QueryError | undefined;

  const client = await connect(connection);
  client.on("notice", (n) => notices.push(`${n.severity ?? "NOTICE"}: ${n.message}`));
  try {
    const pid = (await client.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0].pid;
    running.set(runId, { pid: Number(pid), connection });
    await client.query(`set statement_timeout = ${Math.max(0, Math.floor(opts.statementTimeoutMs ?? 60_000))}`);
    if (readOnly) await client.query("begin read only");
    for (const [index, sql] of prepared.statements.entries()) {
      try {
        results.push(await runStatement(client, sql, maxRows));
      } catch (err) {
        error = toQueryError(err, index, sql);
        break;
      }
    }
    if (readOnly) await client.query("rollback");
    const names = await typeNames(client, [...new Set(results.flatMap((r) => r.columns.map((c) => Number(c.type))))]);
    for (const r of results) for (const c of r.columns) c.type = names.get(Number(c.type)) ?? c.type;
  } finally {
    running.delete(runId);
    await client.end().catch(() => {});
  }

  return {
    runId,
    results,
    notices,
    ignoredMetaCommands: prepared.ignoredMetaCommands,
    error,
    durationMs: Math.round(performance.now() - started),
    readOnly,
  };
}

export interface ExplainOptions {
  values?: Record<string, string>;
  analyze?: boolean;
  format?: "json" | "text";
  statementTimeoutMs?: number;
  readOnly?: boolean;
  runId?: string;
}

export interface ExplainResult {
  runId: string;
  sql: string;
  analyze: boolean;
  format: "json" | "text";
  plan: unknown;
  durationMs: number;
}

// Explains one statement. With analyze the statement really runs, inside a
// transaction that is always rolled back, so writes do not stick.
export async function explain(connection: Connection, script: string, opts: ExplainOptions = {}): Promise<ExplainResult> {
  const prepared = prepareScript(script, opts.values ?? {});
  if (prepared.missing.length) throw new ScriptError(`No value for variable(s): ${prepared.missing.join(", ")}`);
  if (prepared.statements.length !== 1) {
    throw new ScriptError(`Explain needs exactly one statement, got ${prepared.statements.length}`);
  }
  const sql = prepared.statements[0];
  if (isTransactionControl(sql)) throw new ScriptError("Cannot explain a transaction control statement");
  if (/^explain\b/i.test(stripLeadingComments(sql))) throw new ScriptError("Statement is already an EXPLAIN; use Run");

  const analyze = Boolean(opts.analyze);
  const format = opts.format ?? "json";
  const readOnly = Boolean(opts.readOnly || connection.readOnly);
  const options = [
    analyze && "analyze",
    "verbose",
    analyze && "buffers",
    `format ${format}`,
  ].filter(Boolean);

  const runId = opts.runId ?? randomUUID();
  const started = performance.now();
  const client = await connect(connection);
  try {
    const pid = (await client.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0].pid;
    running.set(runId, { pid: Number(pid), connection });
    await client.query(`set statement_timeout = ${Math.max(0, Math.floor(opts.statementTimeoutMs ?? 60_000))}`);
    await client.query(readOnly ? "begin read only" : "begin");
    try {
      const res = await client.query({ text: `explain (${options.join(", ")}) ${sql}`, rowMode: "array" });
      const plan =
        format === "json" ? JSON.parse(String(res.rows[0][0])) : res.rows.map((r) => String(r[0])).join("\n");
      return { runId, sql, analyze, format, plan, durationMs: Math.round(performance.now() - started) };
    } catch (err) {
      throw Object.assign(new Error((err as Error).message), { queryError: toQueryError(err, 0, sql) });
    } finally {
      await client.query("rollback").catch(() => {});
    }
  } finally {
    running.delete(runId);
    await client.end().catch(() => {});
  }
}

export async function cancel(runId: string): Promise<boolean> {
  const entry = running.get(runId);
  if (!entry) return false;
  const client = await connect(entry.connection);
  try {
    const res = await client.query<{ ok: string }>("select pg_cancel_backend($1)::text as ok", [entry.pid]);
    return res.rows[0]?.ok === "true";
  } finally {
    await client.end().catch(() => {});
  }
}

export interface PingResult {
  ok: boolean;
  version?: string;
  database?: string;
  user?: string;
  error?: string;
}

// Points at the usual fix for connection errors that are hard to read.
export function connectionHint(message: string): string | undefined {
  if (/pg_hba\.conf.*no encryption/i.test(message)) {
    return "The server only accepts encrypted connections. Add ?sslmode=require to the URL.";
  }
  if (/pg_hba\.conf/i.test(message)) {
    return "The server does not allow this IP address, user or database. Ask whoever runs it to allow your address, or connect through their VPN or bastion.";
  }
  if (/self[- ]signed certificate|unable to (get|verify) (local )?issuer certificate|certificate/i.test(message)) {
    return "The URL asks psqlex to check the server's certificate (sslmode=verify-ca or verify-full) and Node does not trust it. Remove sslmode from the URL, or use sslmode=require, to encrypt without checking it, as psql does.";
  }
  return undefined;
}

export async function ping(connection: Connection): Promise<PingResult> {
  try {
    const client = await connect(connection);
    try {
      const res = await client.query<{ version: string; database: string; user: string }>(
        "select current_setting('server_version') as version, current_database() as database, current_user as user",
      );
      return { ok: true, ...res.rows[0] };
    } finally {
      await client.end().catch(() => {});
    }
  } catch (err) {
    const message = (err as Error).message || String(err);
    const hint = connectionHint(message);
    return { ok: false, error: hint ? `${message}. ${hint}` : message };
  }
}

export interface SchemaTable {
  schema: string;
  name: string;
  kind: string;
  estimatedRows: number | null;
  columns: { name: string; type: string; nullable: boolean; default: string | null }[];
}

const SCHEMA_SQL = `
select n.nspname as schema,
       c.relname as name,
       case c.relkind when 'r' then 'table' when 'p' then 'table' when 'v' then 'view'
                      when 'm' then 'materialized view' when 'f' then 'foreign table' end as kind,
       case when c.reltuples < 0 then null else c.reltuples::bigint::text end as estimated_rows,
       coalesce(json_agg(json_build_object(
         'name', a.attname,
         'type', format_type(a.atttypid, a.atttypmod),
         'nullable', not a.attnotnull,
         'default', pg_get_expr(d.adbin, d.adrelid)
       ) order by a.attnum) filter (where a.attnum is not null), '[]')::text as columns
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
left join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
left join pg_attrdef d on d.adrelid = c.oid and d.adnum = a.attnum
where c.relkind in ('r', 'p', 'v', 'm', 'f')
  and n.nspname not in ('pg_catalog', 'information_schema')
  and n.nspname not like 'pg_toast%'
  and n.nspname not like 'pg_temp%'
  and ($1::text is null or n.nspname = $1)
  and ($2::text is null or c.relname = $2)
group by n.nspname, c.relname, c.relkind, c.reltuples
order by n.nspname, c.relname`;

export async function describeSchema(connection: Connection, schema?: string, table?: string): Promise<SchemaTable[]> {
  const client = await connect(connection);
  try {
    const res = await client.query<{ schema: string; name: string; kind: string; estimated_rows: string | null; columns: string }>(
      SCHEMA_SQL,
      [schema ?? null, table ?? null],
    );
    return res.rows.map((r) => ({
      schema: r.schema,
      name: r.name,
      kind: r.kind,
      estimatedRows: r.estimated_rows === null ? null : Number(r.estimated_rows),
      columns: JSON.parse(r.columns),
    }));
  } finally {
    await client.end().catch(() => {});
  }
}

export async function describeIndexes(connection: Connection, schema: string, table: string): Promise<string[]> {
  const client = await connect(connection);
  try {
    const res = await client.query<{ def: string }>(
      "select indexdef as def from pg_indexes where schemaname = $1 and tablename = $2 order by indexname",
      [schema, table],
    );
    return res.rows.map((r) => r.def);
  } finally {
    await client.end().catch(() => {});
  }
}
