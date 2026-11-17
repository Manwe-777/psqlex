import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ScriptStore, versionOf, type StoreEvent } from "../src/server/scripts.ts";
import { statementForExplain } from "../src/server/runs.ts";
import { planToText } from "../src/server/plan-text.ts";

const tempStore = () => new ScriptStore(mkdtempSync(join(tmpdir(), "psqlex-scripts-")));

describe("ScriptStore", () => {
  it("writes, lists and reads scripts per connection, with a content version", () => {
    const store = tempStore();
    store.write("app/local", "main", "select 1");
    store.write("app/local", "b report", "select 2");
    store.write("app/prod", "main", "select 3");
    expect(store.list("app/local").map((s) => s.name)).toEqual(["b report", "main"]);
    expect(store.read("app/prod", "main")).toMatchObject({ content: "select 3", version: versionOf("select 3") });
  });

  it("refuses a write based on an outdated version and returns the current script", () => {
    const store = tempStore();
    const first = store.write("app/local", "main", "select 1");
    store.write("app/local", "main", "select 2");
    expect(() => store.write("app/local", "main", "select 3", first.version)).toThrow(/changed since/);
    try {
      store.write("app/local", "main", "select 3", first.version);
    } catch (err) {
      expect((err as { status: number }).status).toBe(409);
      expect((err as { current: { content: string } }).current.content).toBe("select 2");
    }
  });

  it("edits one unique occurrence and refuses missing or repeated text", () => {
    const store = tempStore();
    store.write("app/local", "main", "select a from t where a = 1;\nselect a from u;");
    expect(store.edit("app/local", "main", "a = 1", "a = 2").content).toContain("a = 2");
    expect(() => store.edit("app/local", "main", "select a from", "x")).toThrow(/more than once/);
    expect(() => store.edit("app/local", "main", "nope", "x")).toThrow(/not found/);
  });

  it("renames scripts with their last run, and moves a renamed connection's folder", () => {
    const store = tempStore();
    store.write("app/local", "main", "select 1");
    store.saveRun("app/local", "main", { source: "ui", kind: "run", at: "now", sql: "select 1" });
    store.rename("app/local", "main", "renamed");
    expect(store.lastRun("app/local", "renamed")?.sql).toBe("select 1");
    store.moveConnection("app/local", "app/dev");
    expect(store.list("app/dev").map((s) => s.name)).toEqual(["renamed"]);
    expect(store.list("app/local")).toEqual([]);
  });

  it("rejects names that could escape the connection folder", () => {
    const store = tempStore();
    expect(() => store.write("app/local", "../evil", "x")).toThrow(/Invalid script name/);
    expect(() => store.write("app/local", ".hidden", "x")).toThrow(/Invalid script name/);
  });

  it("reports changes made on disk by anyone, once per new version", async () => {
    const store = tempStore();
    store.write("app/local", "existing", "select 0");
    const events: StoreEvent[] = [];
    const stop = store.watch((e) => events.push(e));
    // macOS starts delivering file events a moment after the watch begins.
    await new Promise((r) => setTimeout(r, 150));
    try {
      store.write("app/local", "main", "select 1");
      writeFileSync(join(store.root, "app", "local", "existing.sql"), "select 9"); // an outside editor
      store.saveRun("app/local", "main", { source: "agent", kind: "run", at: "now", sql: "select 1" });
      await new Promise((r) => setTimeout(r, 400));
      store.write("app/local", "main", "select 1"); // same content: no new event
      await new Promise((r) => setTimeout(r, 300));
    } finally {
      stop();
    }
    const summary = events.map((e) => (e.type === "script" ? `script:${e.name}:${e.content}` : `${e.type}:${e.name}`));
    expect(summary.filter((x) => x === "script:main:select 1")).toHaveLength(1);
    expect(summary).toContain("script:existing:select 9");
    expect(summary).toContain("run:main");
  });
});

describe("statementForExplain", () => {
  const script = "\\set n 5\nselect 1;\nselect * from t where id = :n;";
  it("picks one statement and keeps the \\set lines", () => {
    expect(statementForExplain(script, 2)).toBe("\\set n 5\nselect * from t where id = :n");
  });
  it("asks which statement when there are several", () => {
    expect(() => statementForExplain(script)).toThrow(/pass statement \(1 to 2\)/);
    expect(() => statementForExplain(script, 3)).toThrow(/no statement 3/);
  });
});

describe("planToText", () => {
  it("renders nodes, details and timings like psql", () => {
    const text = planToText([
      {
        Plan: {
          "Node Type": "Aggregate", "Startup Cost": 1, "Total Cost": 2, "Plan Rows": 1, "Plan Width": 8,
          Plans: [{ "Node Type": "Seq Scan", "Relation Name": "t", Schema: "public", Alias: "t", "Startup Cost": 0, "Total Cost": 1, "Plan Rows": 10, "Plan Width": 0, Filter: "(a > 1)" }],
        },
        "Planning Time": 0.1,
      },
    ]);
    expect(text).toBe(
      "Aggregate  (cost=1..2 rows=1 width=8)\n  ->  Seq Scan on public.t  (cost=0..1 rows=10 width=0)\n        Filter: (a > 1)\nPlanning Time: 0.1 ms",
    );
  });
});
