import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { connectionAttempts, checkConnectionUrl, editableProjects, maskPassword, parseConfig, saveProjects, unmaskPassword } from "../src/server/config.ts";

describe("password masking", () => {
  it("masks literal passwords and leaves ${VAR} and password-less URLs as written", () => {
    expect(maskPassword("postgresql://u:s3cret@h:5432/db")).toBe("postgresql://u:***@h:5432/db");
    expect(maskPassword("postgresql://u:${PG_PASS}@h/db")).toBe("postgresql://u:${PG_PASS}@h/db");
    expect(maskPassword("postgresql://postgres@localhost/db")).toBe("postgresql://postgres@localhost/db");
  });

  it("restores the stored password only where the editor sent the mask", () => {
    expect(unmaskPassword("postgresql://u:***@new-host/db", "postgresql://u:pa$$w@old/db")).toBe("postgresql://u:pa$$w@new-host/db");
    expect(unmaskPassword("postgresql://u:typed@h/db", "postgresql://u:old@h/db")).toBe("postgresql://u:typed@h/db");
  });
});

describe("saveProjects", () => {
  const current = parseConfig({
    projects: [{ name: "a", connections: [{ name: "local", url: "postgresql://u:secret@h/db" }] }],
    mcp: { allowWrites: true, maxRows: 50 },
  });

  it("writes the edited projects, keeps the stored password across a rename and keeps other settings", () => {
    const path = join(mkdtempSync(join(tmpdir(), "psqlex-")), "config.json");
    const edited = editableProjects(current);
    edited[0].name = "renamed";
    edited.push({ name: "b", connections: [{ name: "dev", url: "postgresql://postgres@localhost/b", readOnly: true }] });
    saveProjects(edited, current, path);
    const written = JSON.parse(readFileSync(path, "utf8"));
    expect(written.projects[0]).toEqual({ name: "renamed", connections: [{ name: "local", url: "postgresql://u:secret@h/db", readOnly: false }] });
    expect(written.projects[1].connections[0].readOnly).toBe(true);
    expect(written.mcp).toEqual({ allowWrites: true, maxRows: 50 });
  });

  it("rejects duplicate project and connection names", () => {
    const path = join(mkdtempSync(join(tmpdir(), "psqlex-")), "config.json");
    const dupProjects = [...editableProjects(current), ...editableProjects(current)];
    expect(() => saveProjects(dupProjects, current, path)).toThrow(/Duplicate project name \\"a\\"/);
    const dupConns = editableProjects(current);
    dupConns[0].connections.push({ name: "local", url: "postgresql://x@h/db" });
    expect(() => saveProjects(dupConns, current, path)).toThrow(/Duplicate connection \\"a\/local\\"/);
  });
});

describe("checkConnectionUrl", () => {
  it.each([
    ["postgresql://db.example.com:5432/app", /no user name/],
    ["postgresql://:secret@db.example.com/app", /no user name/],
    ["postgresql://admin:se#cret@db.example.com/app", /percent-encode/],
    ["host=db.example.com user=admin", /starting with postgresql:\/\//],
  ])("rejects %s", (url, message) => expect(() => checkConnectionUrl(url)).toThrow(message));

  it.each(["postgresql://admin:se%23cret@db.example.com:5432/app", "postgres://admin@db.example.com/app", "postgresql://db.example.com/app?user=admin"])(
    "accepts %s",
    (url) => expect(() => checkConnectionUrl(url)).not.toThrow(),
  );
});

describe("connectionAttempts", () => {
  it("tries TLS without a certificate check first, then plain, when the URL has no sslmode (like psql)", () => {
    expect(connectionAttempts("postgresql://u@h/db")).toEqual(["postgresql://u@h/db?sslmode=prefer&uselibpqcompat=true", "postgresql://u@h/db"]);
    expect(connectionAttempts("postgresql://u@h/db?application_name=x")).toEqual([
      "postgresql://u@h/db?application_name=x&sslmode=prefer&uselibpqcompat=true",
      "postgresql://u@h/db?application_name=x",
    ]);
  });

  it("treats prefer and require as psql does", () => {
    expect(connectionAttempts("postgresql://u@h/db?sslmode=prefer")).toEqual(["postgresql://u@h/db?sslmode=prefer&uselibpqcompat=true", "postgresql://u@h/db"]);
    expect(connectionAttempts("postgresql://u@h/db?sslmode=require")).toEqual(["postgresql://u@h/db?sslmode=require&uselibpqcompat=true"]);
  });

  it("leaves verify-full, disable and an explicit uselibpqcompat as written", () => {
    for (const url of ["postgresql://u@h/db?sslmode=verify-full", "postgresql://u@h/db?sslmode=disable", "postgresql://u@h/db?sslmode=require&uselibpqcompat=false"]) {
      expect(connectionAttempts(url)).toEqual([url]);
    }
  });
});
