import { beforeAll, describe, expect, it } from "vitest";
import { connectionHint, describeSchema, explain, isTransactionControl, ping, runScript } from "../src/server/db.ts";
import type { Connection } from "../src/server/config.ts";

const conn: Connection = {
  id: "test/local",
  project: "test",
  name: "local",
  url: process.env.PSQLEX_TEST_URL ?? "postgresql://postgres@localhost:5432/postgres",
  readOnly: false,
};

let up = false;
beforeAll(async () => {
  up = (await ping(conn)).ok;
});

describe.runIf(process.env.PSQLEX_SKIP_DB !== "1")("against a live database", () => {
  it("runs several statements, keeps values as text and reports types", async ({ skip }) => {
    if (!up) skip();
    const run = await runScript(conn, "\\set n 3\nselect g, now()::date as d, null::int as z from generate_series(1, :n) g; select 1::bigint as big", { maxRows: 2 });
    expect(run.error).toBeUndefined();
    const [first, second] = run.results;
    expect(first.columns.map((c) => `${c.name}:${c.type}`)).toEqual(["g:integer", "d:date", "z:integer"]);
    expect(first.rows).toHaveLength(2);
    expect(first.truncated).toBe(true);
    expect(first.rows[0][2]).toBeNull();
    expect(second.rows).toEqual([["1"]]);
    expect(second.rowCount).toBe(1);
  });

  it("stops at the first failing statement and returns where it failed", async ({ skip }) => {
    if (!up) skip();
    const run = await runScript(conn, "select 1; select nope from nowhere; select 3");
    expect(run.results).toHaveLength(1);
    expect(run.error).toMatchObject({ code: "42P01", statementIndex: 1, position: 18 });
  });

  it("read-only mode blocks writes and transaction escapes", async ({ skip }) => {
    if (!up) skip();
    const run = await runScript(conn, "create temp table psqlex_t(x int)", { readOnly: true });
    expect(run.error?.code).toBe("25006");
    await expect(runScript(conn, "commit; select 1", { readOnly: true })).rejects.toThrow(/Transaction control/);
  });

  it("explain analyze returns a JSON plan with timings and rolls back writes", async ({ skip }) => {
    if (!up) skip();
    const plan = await explain(conn, "select count(*) from generate_series(1, 1000)", { analyze: true });
    const root = (plan.plan as { Plan: { "Node Type": string }; "Execution Time": number }[])[0];
    expect(root.Plan["Node Type"]).toBe("Aggregate");
    expect(root["Execution Time"]).toBeGreaterThan(0);
    const text = await explain(conn, "select 1", { format: "text" });
    expect(text.plan).toMatch(/Result/);
  });

  it("times out long statements", async ({ skip }) => {
    if (!up) skip();
    const run = await runScript(conn, "select pg_sleep(2)", { statementTimeoutMs: 100 });
    expect(run.error?.code).toBe("57014");
  });

  it("describes the schema", async ({ skip }) => {
    if (!up) skip();
    expect(Array.isArray(await describeSchema(conn))).toBe(true);
  });
});

describe("isTransactionControl", () => {
  it.each(["COMMIT", "  -- hi\nbegin", "end", "set transaction read write", "SET default_transaction_read_only = off", "reset all", "rollback"])(
    "flags %j",
    (sql) => expect(isTransactionControl(sql)).toBe(true),
  );
  it.each(["select 1", "update t set x = 1", "set search_path = foo", "endpoint"])("allows %j", (sql) =>
    expect(isTransactionControl(sql)).toBe(false),
  );
});

describe("connection URLs", () => {
  it("reads ${VAR} from the environment when connecting", async ({ skip }) => {
    if (!up) skip();
    process.env.PSQLEX_TEST_DB = "postgres";
    expect((await ping({ ...conn, url: "postgresql://postgres@localhost:5432/${PSQLEX_TEST_DB}" })).ok).toBe(true);
    expect((await ping({ ...conn, url: "postgresql://postgres@localhost:5432/${PSQLEX_UNSET_VAR}" })).error).toMatch(/PSQLEX_UNSET_VAR is not set/);
  });
});

describe("connectionHint", () => {
  it("points at sslmode for pg_hba rejections without encryption, and at access for other pg_hba rejections", () => {
    expect(connectionHint('no pg_hba.conf entry for host "1.2.3.4", user "r", database "d", no encryption')).toMatch(/sslmode=require/);
    expect(connectionHint('no pg_hba.conf entry for host "1.2.3.4", user "r", database "d", SSL encryption')).toMatch(/allow your address/);
    expect(connectionHint("self-signed certificate in certificate chain")).toMatch(/Remove sslmode from the URL/);
    expect(connectionHint("password authentication failed")).toBeUndefined();
  });
});
