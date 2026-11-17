import { mkdtempSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RunHistory, SAMPLE_ROWS, toEntry, newRunId } from "../src/server/history.ts";
import type { RunResult } from "../src/server/db.ts";
import type { RunRecord } from "../src/server/scripts.ts";

const result = (rows: number, error?: RunResult["error"]): RunResult => ({
  runId: "r",
  results: [{ sql: "select g from s", command: "SELECT", rowCount: rows, columns: [{ name: "g", type: "integer" }], rows: Array.from({ length: rows }, (_, i) => [String(i)]), truncated: false, durationMs: 1 }],
  notices: ["NOTICE: hi"],
  ignoredMetaCommands: [],
  error,
  durationMs: 3,
  readOnly: true,
});

const record = (at: string, over: Partial<RunRecord> = {}): RunRecord => ({ source: "agent", kind: "run", at, sql: "select :n", values: { n: "1" }, result: result(30), ...over });

describe("toEntry", () => {
  it("keeps the SQL, values, notices and a sample of rows", () => {
    const e = toEntry("app/local", "main", record("2026-11-17T10:00:00.000Z"));
    expect(e).toMatchObject({ connection: "app/local", script: "main", ok: true, values: { n: "1" }, notices: ["NOTICE: hi"] });
    expect(e.statements![0].sampleRows).toHaveLength(SAMPLE_ROWS);
    expect(e.statements![0].truncated).toBe(true);
    expect(e.statements![0].columns).toEqual(["g integer"]);
  });

  it("marks a run whose statement failed, and a run that could not start, as failed", () => {
    const failed = toEntry("app/local", undefined, record("2026-11-17T10:00:00.000Z", { result: result(1, { message: "boom", code: "42P01", statementIndex: 1 }) }));
    expect(failed).toMatchObject({ ok: false, error: { code: "42P01", statementIndex: 1 } });
    const refused = toEntry("app/local", undefined, record("2026-11-17T10:00:00.000Z", { result: undefined, error: { message: "No value for variable(s): n" } }));
    expect(refused).toMatchObject({ ok: false, error: { message: "No value for variable(s): n" } });
  });
});

describe("RunHistory", () => {
  it("lists newest first across connections, filters, and fetches one run by id", () => {
    const history = new RunHistory(mkdtempSync(join(tmpdir(), "psqlex-history-")));
    const ok = toEntry("app/local", "main", record("2026-11-16T09:00:00.000Z", { source: "ui" }));
    const bad = toEntry("app/local", "main", record("2026-11-17T09:00:00.000Z", { result: undefined, error: { message: "boom", code: "XX000" } }));
    const other = toEntry("app/prod", undefined, record("2026-11-17T10:00:00.000Z"));
    for (const e of [ok, bad, other]) history.append(e);

    expect(history.list().map((s) => s.id)).toEqual([other.id, bad.id, ok.id]);
    expect(history.list({ connection: "app/local" }).map((s) => s.id)).toEqual([bad.id, ok.id]);
    expect(history.list({ failedOnly: true })).toMatchObject([{ id: bad.id, error: "[XX000] boom" }]);
    expect(history.list({ source: "ui" }).map((s) => s.id)).toEqual([ok.id]);
    expect(history.list({ since: "2026-11-17" }).map((s) => s.id)).toEqual([other.id, bad.id]);
    expect(history.list({ limit: 1 })).toHaveLength(1);
    expect(history.get(bad.id)).toMatchObject({ sql: "select :n", error: { code: "XX000" } });
    expect(history.get("20260101T000000-000000")).toBeNull();
  });

  it("skips a line cut short by a crash and deletes day files older than 30 days", () => {
    const root = mkdtempSync(join(tmpdir(), "psqlex-history-"));
    const dir = join(root, "app", "local", ".history");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "2001-01-01.jsonl"), "{}\n");
    const history = new RunHistory(root);
    const now = new Date().toISOString();
    const entry = toEntry("app/local", undefined, record(now));
    history.append(entry);
    writeFileSync(join(dir, `${now.slice(0, 10)}.jsonl`), `${JSON.stringify(entry)}\n{"id": "half`, { flag: "w" });
    expect(readdirSync(dir)).toEqual([`${now.slice(0, 10)}.jsonl`]);
    expect(history.list().map((s) => s.id)).toEqual([entry.id]);
  });

  it("makes ids that sort by time and name their day", () => {
    expect(newRunId("2026-11-17T14:31:46.504Z")).toMatch(/^20261117T143146-[0-9a-f]{6}$/);
  });
});
