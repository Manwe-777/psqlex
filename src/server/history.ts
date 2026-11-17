import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ExplainResult, QueryError, RunResult } from "./db.ts";
import type { RunRecord } from "./scripts.ts";

// Every run, from the page or an agent, is appended as one JSON line to
//   <scripts root>/<project>/<connection>/.history/<YYYY-MM-DD>.jsonl
// so an agent can look back at what ran and why it failed. Rows are cut to a
// sample to keep the files small; the SQL is stored after variable substitution.

export const SAMPLE_ROWS = 20;
export const KEEP_DAYS = 30;

export interface HistoryEntry {
  id: string;
  at: string;
  connection: string;
  script?: string;
  source: RunRecord["source"];
  kind: RunRecord["kind"];
  analyze?: boolean;
  sql: string;
  values?: Record<string, string>;
  ok: boolean;
  durationMs?: number;
  error?: QueryError;
  notices?: string[];
  statements?: {
    sql: string;
    command: string | null;
    rowCount: number | null;
    durationMs: number;
    columns: string[];
    sampleRows: (string | null)[][];
    truncated: boolean;
  }[];
  plan?: unknown;
}

export interface HistorySummary {
  id: string;
  at: string;
  connection: string;
  script?: string;
  source: RunRecord["source"];
  kind: RunRecord["kind"];
  ok: boolean;
  durationMs?: number;
  error?: string;
  sql: string;
}

const day = (iso: string) => iso.slice(0, 10);

// Ids sort by time and say which day file holds them: 20261117T143146-3f9a2c.
export function newRunId(at: string): string {
  return `${at.replace(/[-:]/g, "").slice(0, 15)}-${randomBytes(3).toString("hex")}`;
}

function dayFromId(id: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})T/.exec(id);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

export function toEntry(connection: string, script: string | undefined, record: RunRecord, id = newRunId(record.at)): HistoryEntry {
  const entry: HistoryEntry = {
    id,
    at: record.at,
    connection,
    script,
    source: record.source,
    kind: record.kind,
    analyze: record.analyze,
    sql: record.sql,
    values: record.values,
    ok: !record.error,
  };
  if (record.error) {
    entry.error = record.error as QueryError;
    return entry;
  }
  if (record.kind === "explain") {
    const result = record.result as ExplainResult;
    entry.durationMs = result.durationMs;
    entry.plan = result.plan;
    entry.sql = result.sql;
    return entry;
  }
  const result = record.result as RunResult;
  entry.durationMs = result.durationMs;
  entry.ok = !result.error;
  entry.error = result.error;
  entry.notices = result.notices.length ? result.notices : undefined;
  entry.statements = result.results.map((r) => ({
    sql: r.sql,
    command: r.command,
    rowCount: r.rowCount,
    durationMs: r.durationMs,
    columns: r.columns.map((c) => `${c.name} ${c.type}`),
    sampleRows: r.rows.slice(0, SAMPLE_ROWS),
    truncated: r.truncated || r.rows.length > SAMPLE_ROWS,
  }));
  return entry;
}

export class RunHistory {
  constructor(private root: string) {}

  private dir(connection: string): string {
    const slash = connection.indexOf("/");
    return join(this.root, encodeURIComponent(connection.slice(0, slash)), encodeURIComponent(connection.slice(slash + 1)), ".history");
  }

  append(entry: HistoryEntry) {
    const dir = this.dir(entry.connection);
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, `${day(entry.at)}.jsonl`), `${JSON.stringify(entry)}\n`);
    this.prune(dir);
  }

  private prune(dir: string) {
    const cutoff = new Date(Date.now() - KEEP_DAYS * 86_400_000).toISOString().slice(0, 10);
    for (const f of readdirSync(dir)) {
      if (f.endsWith(".jsonl") && f.slice(0, 10) < cutoff) rmSync(join(dir, f), { force: true });
    }
  }

  private connectionDirs(): { connection: string; dir: string }[] {
    if (!existsSync(this.root)) return [];
    const out: { connection: string; dir: string }[] = [];
    for (const project of readdirSync(this.root)) {
      const pdir = join(this.root, project);
      if (!statSync(pdir).isDirectory()) continue;
      for (const conn of readdirSync(pdir)) {
        const dir = join(pdir, conn, ".history");
        if (existsSync(dir)) out.push({ connection: `${decodeURIComponent(project)}/${decodeURIComponent(conn)}`, dir });
      }
    }
    return out;
  }

  private static read(file: string): HistoryEntry[] {
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as HistoryEntry];
        } catch {
          return []; // a line cut short by a crash
        }
      });
  }

  // Newest first. Reads day files from the newest back until it has enough.
  list(filter: { connection?: string; script?: string; source?: RunRecord["source"]; failedOnly?: boolean; since?: string; limit?: number } = {}): HistorySummary[] {
    const limit = filter.limit ?? 20;
    const dirs = this.connectionDirs().filter((d) => !filter.connection || d.connection === filter.connection);
    const days = [...new Set(dirs.flatMap((d) => readdirSync(d.dir).filter((f) => f.endsWith(".jsonl"))))].sort().reverse();
    const out: HistorySummary[] = [];
    for (const f of days) {
      if (filter.since && f.slice(0, 10) < filter.since.slice(0, 10)) break;
      const entries = dirs.flatMap((d) => RunHistory.read(join(d.dir, f)));
      entries.sort((a, b) => b.at.localeCompare(a.at));
      for (const e of entries) {
        if (filter.since && e.at < filter.since) continue;
        if (filter.script && e.script !== filter.script) continue;
        if (filter.source && e.source !== filter.source) continue;
        if (filter.failedOnly && e.ok) continue;
        out.push({
          id: e.id,
          at: e.at,
          connection: e.connection,
          script: e.script,
          source: e.source,
          kind: e.kind,
          ok: e.ok,
          durationMs: e.durationMs,
          error: e.error ? `${e.error.code ? `[${e.error.code}] ` : ""}${e.error.message}` : undefined,
          sql: e.sql.length > 200 ? `${e.sql.slice(0, 200)}…` : e.sql,
        });
        if (out.length >= limit) return out;
      }
    }
    return out;
  }

  get(id: string): HistoryEntry | null {
    const d = dayFromId(id);
    if (!d) return null;
    for (const { dir } of this.connectionDirs()) {
      const hit = RunHistory.read(join(dir, `${d}.jsonl`)).find((e) => e.id === id);
      if (hit) return hit;
    }
    return null;
  }
}
