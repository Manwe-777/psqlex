import { describe, expect, it } from "vitest";
import { listVariables, prepareScript, scan, statementAt } from "../src/shared/sql.ts";

describe("scan", () => {
  it("splits statements and ignores semicolons in strings, comments and dollar quotes", () => {
    const sql = `select ';'; -- a ; comment\nselect $$ ; $$; /* ; */ select "a;b" from t;`;
    expect(scan(sql).statements.map((s) => s.text)).toEqual([
      "select ';'",
      "-- a ; comment\nselect $$ ; $$",
      `/* ; */ select "a;b" from t`,
    ]);
  });

  it("finds psql variables but not casts, array slices or colons inside strings", () => {
    const sql = `select :a, :'b', :"c", x::int, arr[1:n], ':nope', $f$ :nope $f$ from t where y = :a`;
    expect(scan(sql).vars.map((v) => `${v.style}:${v.name}`)).toEqual(["raw:a", "literal:b", "identifier:c", "raw:a"]);
  });

  it("treats backslash lines as meta-commands and statement boundaries", () => {
    const { metas, statements } = scan("\\set x 5\nselect 1\n\\timing on\nselect 2");
    expect(metas.map((m) => [m.command, m.args])).toEqual([["set", "x 5"], ["timing", "on"]]);
    expect(statements.map((s) => s.text)).toEqual(["select 1", "select 2"]);
  });
});

describe("prepareScript", () => {
  it("substitutes values with psql quoting rules, values overriding \\set", () => {
    const p = prepareScript("\\set n 3\n\\set who 'O''Brien'\nselect :n, :'who', :\"tbl\".id from :\"tbl\"", { n: "4", tbl: 'we"ird' });
    expect(p.statements).toEqual([`select 4, 'O''Brien', "we""ird".id from "we""ird"`]);
    expect(p.missing).toEqual([]);
  });

  it("reports missing variables and ignored meta-commands", () => {
    const p = prepareScript("\\x\nselect :a, :b", { a: "1" });
    expect(p.missing).toEqual(["b"]);
    expect(p.ignoredMetaCommands).toEqual(["\\x"]);
  });

  it("escapes backslashes in literals with an E-string", () => {
    expect(prepareScript("select :'p'", { p: "a\\b" }).statements).toEqual(["select E'a\\\\b'"]);
  });
});

describe("helpers", () => {
  it("lists variables with their \\set defaults", () => {
    expect(listVariables("\\set a 1\nselect :a, :b")).toEqual([{ name: "a", default: "1" }, { name: "b", default: undefined }]);
  });

  it("finds the statement under the cursor", () => {
    const sql = "select 1;\n\nselect 2;\nselect 3";
    expect(statementAt(sql, sql.indexOf("2"))?.text).toBe("select 2");
    expect(statementAt(sql, 0)?.text).toBe("select 1");
  });
});
