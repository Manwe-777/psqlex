import { readFileSync, existsSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { parse as parsePgUrl } from "pg-connection-string";

const ConnectionSchema = z.object({
  name: z.string().min(1),
  url: z.string().min(1),
  readOnly: z.boolean().default(false),
  description: z.string().optional(),
});

const ProjectSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  connections: z.array(ConnectionSchema).min(1),
});

const ProjectsSchema = z.array(ProjectSchema).superRefine((projects, ctx) => {
  const names = new Set<string>();
  for (const [i, p] of projects.entries()) {
    if (names.has(p.name)) ctx.addIssue({ code: "custom", path: [i, "name"], message: `Duplicate project name "${p.name}"` });
    names.add(p.name);
    const conns = new Set<string>();
    for (const [j, c] of p.connections.entries()) {
      if (conns.has(c.name)) {
        ctx.addIssue({ code: "custom", path: [i, "connections", j, "name"], message: `Duplicate connection "${p.name}/${c.name}"` });
      }
      conns.add(c.name);
    }
  }
});

const ConfigSchema = z.object({
  projects: ProjectsSchema,
  mcp: z
    .object({
      allowWrites: z.boolean().default(false),
      maxRows: z.number().int().positive().default(200),
    })
    .default({ allowWrites: false, maxRows: 200 }),
  ui: z
    .object({
      maxRows: z.number().int().positive().default(1000),
      statementTimeoutMs: z.number().int().nonnegative().default(60_000),
    })
    .default({ maxRows: 1000, statementTimeoutMs: 60_000 }),
});

export type Config = z.infer<typeof ConfigSchema>;

export interface Connection {
  id: string;
  project: string;
  name: string;
  url: string;
  readOnly: boolean;
  description?: string;
}

export type Project = z.infer<typeof ProjectSchema>;

// The folder holding package.json, found by walking up so the same code works
// from src/server (tsx) and from the dist/psqlex.mjs bundle.
export function appRoot(): string {
  let dir = import.meta.dirname;
  while (!existsSync(join(dir, "package.json"))) {
    const parent = dirname(dir);
    if (parent === dir) return import.meta.dirname;
    dir = parent;
  }
  return dir;
}

export function userConfigPath(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "psqlex", "config.json");
}

// PSQLEX_CONFIG wins. Otherwise ~/.config/psqlex/config.json, unless only a
// psqlex.config.json next to the app exists (setups from before the move).
export function configPath(): string {
  if (process.env.PSQLEX_CONFIG) return resolve(process.env.PSQLEX_CONFIG);
  const user = userConfigPath();
  const legacy = join(appRoot(), "psqlex.config.json");
  if (!existsSync(user) && existsSync(legacy)) return legacy;
  return user;
}

export const writableConfigPath = configPath;

// ${VAR} in a connection URL is read from the environment, so passwords can
// stay out of the config file.
export function interpolateEnv(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
    const v = env[name];
    if (v === undefined) throw new Error(`Environment variable ${name} is not set`);
    return v;
  });
}

export function parseConfig(raw: unknown): Config {
  return ConfigSchema.parse(raw);
}

export function loadConfig(path = configPath()): Config {
  if (!existsSync(path)) return parseConfig({ projects: [] });
  return parseConfig(JSON.parse(readFileSync(path, "utf8")));
}

export function listConnections(config: Config): Connection[] {
  return config.projects.flatMap((p) =>
    p.connections.map((c) => ({
      id: `${p.name}/${c.name}`,
      project: p.name,
      name: c.name,
      url: c.url,
      readOnly: c.readOnly,
      description: c.description ?? p.description,
    })),
  );
}

// The URL with any password replaced, for showing in the UI or to agents.
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return url.replace(/:[^:@/]+@/, ":***@");
  }
}

export const MASK = "***";

// scheme://user:password@ — matched as text, because URL() would percent-encode ${VAR}.
const PASSWORD = /^([a-z][a-z0-9+.-]*:\/\/[^:/@]*:)([^@]*)(@)/i;

// Swaps a literal password for MASK so the editor never shows it.
// ${VAR} placeholders are not secrets and stay visible.
export function maskPassword(url: string): string {
  return url.replace(PASSWORD, (all, head: string, password: string, at: string) =>
    !password || /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(password) ? all : `${head}${MASK}${at}`,
  );
}

// Puts the stored password back into a URL the editor sent with MASK in it.
export function unmaskPassword(url: string, previous: string | undefined): string {
  const m = PASSWORD.exec(url);
  if (!m || m[2] !== MASK || !previous) return url;
  const old = PASSWORD.exec(previous);
  return old ? url.replace(PASSWORD, `$1${old[2].replace(/\$/g, "$$$$")}$3`) : url;
}

export interface EditableConnection {
  name: string;
  url: string;
  readOnly?: boolean;
  description?: string;
  // "project/name" this connection had when loaded, so a masked password can
  // be found again after a rename.
  originalId?: string;
}

export interface EditableProject {
  name: string;
  description?: string;
  connections: EditableConnection[];
}

export function editableProjects(config: Config): EditableProject[] {
  return config.projects.map((p) => ({
    ...p,
    connections: p.connections.map((c) => ({ ...c, url: maskPassword(c.url), originalId: `${p.name}/${c.name}` })),
  }));
}

export function resolveEditedUrl(config: Config, conn: EditableConnection): string {
  const previous = conn.originalId ? listConnections(config).find((c) => c.id === conn.originalId)?.url : undefined;
  return unmaskPassword(conn.url, previous);
}

// Replaces the project list and keeps the mcp and ui settings as they were.
export function saveProjects(edited: EditableProject[], current: Config, path = writableConfigPath()): Config {
  const projects = ProjectsSchema.parse(
    edited.map((p) => ({
      name: p.name.trim(),
      description: p.description?.trim() || undefined,
      connections: p.connections.map((c) => ({
        name: c.name.trim(),
        url: resolveEditedUrl(current, c).trim(),
        readOnly: Boolean(c.readOnly),
        description: c.description?.trim() || undefined,
      })),
    })),
  );
  const next: Config = { ...current, projects };
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  // The file can hold passwords, so only the owner may read it.
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  return next;
}

export class ConnectionUrlError extends Error {}

// Catches URLs that would connect as the wrong user or fail with a vague
// "Invalid URL". Without a user name, the pg driver silently uses the OS login.
export function checkConnectionUrl(url: string): void {
  if (!/^postgres(ql)?:\/\//i.test(url.trim())) {
    throw new ConnectionUrlError(
      "The connection must be a URL starting with postgresql://, e.g. postgresql://USER:PASSWORD@HOST:5432/DATABASE",
    );
  }
  let parsed: ReturnType<typeof parsePgUrl>;
  try {
    parsed = parsePgUrl(url);
  } catch {
    throw new ConnectionUrlError(
      "The URL could not be parsed. If the user name or password contains @ # / ? : or %, percent-encode those characters (@ is %40, # is %23, / is %2F, ? is %3F, : is %3A, % is %25).",
    );
  }
  if (!parsed.user) {
    throw new ConnectionUrlError(
      "The URL has no user name. Put it before the host: postgresql://USER:PASSWORD@HOST:5432/DATABASE",
    );
  }
  if (!parsed.host) throw new ConnectionUrlError("The URL has no host name.");
}

// The URLs to try, in order, so connections behave like psql and most GUI
// clients. node-postgres differs from them in two ways: with no sslmode it never
// tries TLS, and it treats require/prefer as full certificate checks. Managed
// databases such as RDS often require TLS and use CAs that Node does not trust.
//   no sslmode / prefer: TLS without a certificate check, then unencrypted if
//                        the server has no TLS (libpq's default, "prefer")
//   require:             TLS without a certificate check
//   anything else, or an explicit uselibpqcompat: exactly as written
export function connectionAttempts(url: string): string[] {
  const q = url.indexOf("?");
  const params = new URLSearchParams(q === -1 ? "" : url.slice(q + 1));
  if (params.has("uselibpqcompat")) return [url];
  const mode = params.get("sslmode");
  const join = q === -1 ? "?" : "&";
  if (mode === null) return [`${url}${join}sslmode=prefer&uselibpqcompat=true`, url];
  if (mode === "prefer") {
    params.delete("sslmode");
    const rest = params.toString();
    return [`${url}&uselibpqcompat=true`, `${url.slice(0, q)}${rest ? `?${rest}` : ""}`];
  }
  if (mode === "require") return [`${url}&uselibpqcompat=true`];
  return [url];
}
