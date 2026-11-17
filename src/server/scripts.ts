import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, watch, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Scripts are plain .sql files, one folder per connection:
//   <root>/<project>/<connection>/<name>.sql
// and the last run of each script sits next to them:
//   <root>/<project>/<connection>/.runs/<name>.json
// Everything goes through files so the web server, a separate stdio MCP
// process and any editor all see the same state; the web server watches the
// folder and pushes changes to the browser.

export function scriptsRoot(): string {
  if (process.env.PSQLEX_DATA) return join(process.env.PSQLEX_DATA, "scripts");
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "psqlex", "scripts");
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,79}$/;

export class ScriptError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export function checkName(name: string): string {
  const trimmed = name.trim().replace(/\.sql$/i, "");
  if (!NAME.test(trimmed)) {
    throw new ScriptError(`Invalid script name "${name}": use letters, digits, spaces, _ . - (up to 80 characters)`);
  }
  return trimmed;
}

export const versionOf = (content: string) => createHash("sha1").update(content).digest("hex").slice(0, 12);

export interface ScriptInfo {
  connection: string;
  name: string;
  version: string;
  updatedAt: string;
  size: number;
}

export interface Script extends ScriptInfo {
  content: string;
}

export interface RunRecord {
  source: "ui" | "agent";
  kind: "run" | "explain";
  analyze?: boolean;
  at: string;
  sql: string;
  values?: Record<string, string>;
  result?: unknown;
  error?: unknown;
}

// "project/name" connection ids map to two encoded folder names.
function connectionDir(root: string, connection: string): string {
  const slash = connection.indexOf("/");
  if (slash <= 0) throw new ScriptError(`Invalid connection id "${connection}"`);
  return join(root, encodeURIComponent(connection.slice(0, slash)), encodeURIComponent(connection.slice(slash + 1)));
}

function connectionFromDirs(project: string, name: string): string {
  return `${decodeURIComponent(project)}/${decodeURIComponent(name)}`;
}

function writeAtomic(path: string, content: string) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

export class ScriptStore {
  constructor(public root = scriptsRoot()) {}

  private file(connection: string, name: string) {
    return join(connectionDir(this.root, connection), `${checkName(name)}.sql`);
  }

  private runFile(connection: string, name: string) {
    return join(connectionDir(this.root, connection), ".runs", `${checkName(name)}.json`);
  }

  list(connection: string): ScriptInfo[] {
    const dir = connectionDir(this.root, connection);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith(".sql") && NAME.test(f.slice(0, -4)))
      .map((f) => {
        const path = join(dir, f);
        const content = readFileSync(path, "utf8");
        return { connection, name: f.slice(0, -4), version: versionOf(content), updatedAt: statSync(path).mtime.toISOString(), size: content.length };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  read(connection: string, name: string): Script {
    const path = this.file(connection, name);
    if (!existsSync(path)) throw new ScriptError(`No script "${name}" on ${connection}`, 404);
    const content = readFileSync(path, "utf8");
    return { connection, name: checkName(name), content, version: versionOf(content), updatedAt: statSync(path).mtime.toISOString(), size: content.length };
  }

  exists(connection: string, name: string): boolean {
    return existsSync(this.file(connection, name));
  }

  // baseVersion, when given, must match the file on disk; a mismatch means
  // someone else changed it since the caller last read it.
  write(connection: string, name: string, content: string, baseVersion?: string): Script {
    const path = this.file(connection, name);
    if (baseVersion !== undefined && existsSync(path)) {
      const current = readFileSync(path, "utf8");
      if (versionOf(current) !== baseVersion) {
        throw Object.assign(new ScriptError(`Script "${name}" changed since version ${baseVersion}`, 409), {
          current: this.read(connection, name),
        });
      }
    }
    mkdirSync(connectionDir(this.root, connection), { recursive: true });
    writeAtomic(path, content);
    return this.read(connection, name);
  }

  // Replaces one exact, unique occurrence of oldText, the way agents edit files.
  edit(connection: string, name: string, oldText: string, newText: string): Script {
    const { content } = this.read(connection, name);
    const at = content.indexOf(oldText);
    if (oldText === "" || at === -1) throw new ScriptError(`The text to replace was not found in "${name}"`);
    if (content.indexOf(oldText, at + 1) !== -1) {
      throw new ScriptError(`The text to replace appears more than once in "${name}"; include more surrounding text`);
    }
    return this.write(connection, name, content.slice(0, at) + newText + content.slice(at + oldText.length));
  }

  remove(connection: string, name: string) {
    rmSync(this.file(connection, name), { force: true });
    rmSync(this.runFile(connection, name), { force: true });
  }

  rename(connection: string, from: string, to: string): Script {
    const target = this.file(connection, to);
    if (existsSync(target)) throw new ScriptError(`A script named "${checkName(to)}" already exists`, 409);
    renameSync(this.file(connection, from), target);
    if (existsSync(this.runFile(connection, from))) {
      mkdirSync(join(connectionDir(this.root, connection), ".runs"), { recursive: true });
      renameSync(this.runFile(connection, from), this.runFile(connection, to));
    }
    return this.read(connection, to);
  }

  // Keeps scripts with their connection when the connection is renamed.
  moveConnection(from: string, to: string) {
    const src = connectionDir(this.root, from);
    const dest = connectionDir(this.root, to);
    if (from === to || !existsSync(src) || existsSync(dest)) return;
    mkdirSync(join(dest, ".."), { recursive: true });
    renameSync(src, dest);
  }

  saveRun(connection: string, name: string, run: RunRecord) {
    const path = this.runFile(connection, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeAtomic(path, JSON.stringify(run));
  }

  lastRun(connection: string, name: string): RunRecord | null {
    const path = this.runFile(connection, name);
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, "utf8")) as RunRecord;
    } catch {
      return null;
    }
  }

  // Calls back for every script or run file that changes on disk, whoever
  // wrote it. Unchanged content (same version) is not reported twice.
  watch(onEvent: (event: StoreEvent) => void): () => void {
    mkdirSync(this.root, { recursive: true });
    const seen = new Map<string, string>();
    const timers = new Map<string, NodeJS.Timeout>();

    const handle = (rel: string) => {
      const parts = rel.split(/[\\/]/);
      try {
        if (parts.length === 3 && parts[2].endsWith(".sql")) {
          const connection = connectionFromDirs(parts[0], parts[1]);
          const name = parts[2].slice(0, -4);
          if (!NAME.test(name)) return;
          const path = join(this.root, rel);
          if (!existsSync(path)) {
            if (seen.delete(rel)) onEvent({ type: "script-deleted", connection, name });
            return;
          }
          const content = readFileSync(path, "utf8");
          const version = versionOf(content);
          if (seen.get(rel) === version) return;
          seen.set(rel, version);
          onEvent({ type: "script", connection, name, version, content, updatedAt: statSync(path).mtime.toISOString() });
        } else if (parts.length === 4 && parts[2] === ".runs" && parts[3].endsWith(".json")) {
          const connection = connectionFromDirs(parts[0], parts[1]);
          const name = parts[3].slice(0, -5);
          const run = this.lastRun(connection, name);
          if (run) onEvent({ type: "run", connection, name, run });
        }
      } catch {
        // A file can vanish between the event and the read; the next event catches up.
      }
    };

    // Prime versions so files that already exist are not reported as new.
    for (const project of existsSync(this.root) ? readdirSync(this.root) : []) {
      const pdir = join(this.root, project);
      if (!statSync(pdir).isDirectory()) continue;
      for (const conn of readdirSync(pdir)) {
        const cdir = join(pdir, conn);
        if (!statSync(cdir).isDirectory()) continue;
        for (const f of readdirSync(cdir)) {
          if (f.endsWith(".sql")) seen.set(join(project, conn, f), versionOf(readFileSync(join(cdir, f), "utf8")));
        }
      }
    }

    const watcher = watch(this.root, { recursive: true }, (_type, filename) => {
      if (!filename || filename.endsWith(".tmp")) return;
      const rel = filename.toString();
      clearTimeout(timers.get(rel));
      timers.set(rel, setTimeout(() => (timers.delete(rel), handle(rel)), 40));
    });
    return () => {
      watcher.close();
      for (const t of timers.values()) clearTimeout(t);
    };
  }
}

export type StoreEvent =
  | { type: "script"; connection: string; name: string; version: string; content: string; updatedAt: string }
  | { type: "script-deleted"; connection: string; name: string }
  | { type: "run"; connection: string; name: string; run: RunRecord };
