// Scans SQL text the way psql does for the things psqlex needs: statement
// boundaries, psql variables (:name, :'name', :"name") and backslash
// meta-commands. Strings, quoted identifiers, dollar quotes and comments are
// skipped so a colon or semicolon inside them is left alone.

export type VarStyle = "raw" | "literal" | "identifier";

export interface VarRef {
  name: string;
  style: VarStyle;
  start: number;
  end: number;
}

export interface MetaCommand {
  command: string;
  args: string;
  start: number;
  end: number;
}

export interface Statement {
  text: string;
  start: number;
  end: number;
}

export interface ScanResult {
  vars: VarRef[];
  metas: MetaCommand[];
  statements: Statement[];
}

const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_]/;

export function scan(sql: string): ScanResult {
  const vars: VarRef[] = [];
  const metas: MetaCommand[] = [];
  const statements: Statement[] = [];
  let stmtStart = 0;
  let i = 0;
  const n = sql.length;

  const pushStatement = (end: number) => {
    const raw = sql.slice(stmtStart, end);
    if (raw.trim()) {
      const lead = raw.length - raw.trimStart().length;
      const text = raw.trim();
      statements.push({ text, start: stmtStart + lead, end: stmtStart + lead + text.length });
    }
  };

  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];

    if (c === "-" && next === "-") {
      while (i < n && sql[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth--;
          i += 2;
        } else i++;
      }
      continue;
    }
    if (c === "'") {
      const escapes = i > 0 && (sql[i - 1] === "E" || sql[i - 1] === "e");
      i++;
      while (i < n) {
        if (escapes && sql[i] === "\\") {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          break;
        }
        i++;
      }
      i++;
      continue;
    }
    if (c === '"') {
      i++;
      while (i < n) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            i += 2;
            continue;
          }
          break;
        }
        i++;
      }
      i++;
      continue;
    }
    if (c === "$") {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m && !(i > 0 && IDENT_PART.test(sql[i - 1]))) {
        const tag = m[0];
        const close = sql.indexOf(tag, i + tag.length);
        i = close === -1 ? n : close + tag.length;
        continue;
      }
    }
    if (c === "\\" && isLineStart(sql, i)) {
      let end = sql.indexOf("\n", i);
      if (end === -1) end = n;
      const line = sql.slice(i + 1, end).trim();
      const space = line.search(/\s/);
      metas.push({
        command: space === -1 ? line : line.slice(0, space),
        args: space === -1 ? "" : line.slice(space + 1).trim(),
        start: i,
        end,
      });
      pushStatement(i);
      stmtStart = end;
      i = end;
      continue;
    }
    if (c === ":") {
      if (next === ":") {
        i += 2;
        continue;
      }
      const ref = readVar(sql, i);
      if (ref) {
        vars.push(ref);
        i = ref.end;
        continue;
      }
    }
    if (c === ";") {
      pushStatement(i);
      stmtStart = i + 1;
    }
    i++;
  }
  pushStatement(n);
  return { vars, metas, statements };
}

function isLineStart(sql: string, i: number): boolean {
  let j = i - 1;
  while (j >= 0 && (sql[j] === " " || sql[j] === "\t")) j--;
  return j < 0 || sql[j] === "\n";
}

function readVar(sql: string, i: number): VarRef | null {
  const q = sql[i + 1];
  if (q === "'" || q === '"') {
    let j = i + 2;
    if (!IDENT_START.test(sql[j] ?? "")) return null;
    while (IDENT_PART.test(sql[j] ?? "")) j++;
    if (sql[j] !== q) return null;
    return { name: sql.slice(i + 2, j), style: q === "'" ? "literal" : "identifier", start: i, end: j + 1 };
  }
  // A colon glued to a preceding word or number is an array slice (arr[1:n]), not a variable.
  if (i > 0 && /[A-Za-z0-9_\]]/.test(sql[i - 1])) return null;
  let j = i + 1;
  if (!IDENT_START.test(sql[j] ?? "")) return null;
  while (IDENT_PART.test(sql[j] ?? "")) j++;
  return { name: sql.slice(i + 1, j), style: "raw", start: i, end: j };
}

export function quoteLiteral(value: string): string {
  const escaped = value.replace(/'/g, "''");
  return value.includes("\\") ? `E'${escaped.replace(/\\/g, "\\\\")}'` : `'${escaped}'`;
}

export function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

// Parses the value part of a psql `\set name value` line. Single-quoted parts
// are unquoted; everything else is taken as written.
export function parseSetValue(args: string): { name: string; value: string } | null {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*(.*)$/s.exec(args);
  if (!m) return null;
  let value = m[2].trim();
  const quoted = /^'((?:[^']|'')*)'$/.exec(value);
  if (quoted) value = quoted[1].replace(/''/g, "'");
  return { name: m[1], value };
}

export interface PreparedScript {
  statements: string[];
  variables: string[];
  missing: string[];
  ignoredMetaCommands: string[];
  defaults: Record<string, string>;
}

// Turns a psql-style script into plain SQL statements: applies `\set` lines,
// then values passed in (which win over `\set`), and drops other meta-commands.
export function prepareScript(sql: string, values: Record<string, string> = {}): PreparedScript {
  const { metas } = scan(sql);
  const defaults: Record<string, string> = {};
  const ignored: string[] = [];
  for (const meta of metas) {
    if (meta.command === "set") {
      const parsed = parseSetValue(meta.args);
      if (parsed) defaults[parsed.name] = parsed.value;
    } else {
      ignored.push(`\\${meta.command}`);
    }
  }

  let stripped = "";
  let last = 0;
  for (const meta of metas) {
    stripped += sql.slice(last, meta.start) + " ".repeat(meta.end - meta.start);
    last = meta.end;
  }
  stripped += sql.slice(last);

  const merged = { ...defaults, ...definedOnly(values) };
  const { vars } = scan(stripped);
  const variables = [...new Set(vars.map((v) => v.name))];
  const missing = variables.filter((v) => merged[v] === undefined);

  let out = "";
  last = 0;
  for (const ref of vars) {
    const value = merged[ref.name];
    out += stripped.slice(last, ref.start);
    if (value === undefined) out += stripped.slice(ref.start, ref.end);
    else if (ref.style === "literal") out += quoteLiteral(value);
    else if (ref.style === "identifier") out += quoteIdentifier(value);
    else out += value;
    last = ref.end;
  }
  out += stripped.slice(last);

  return {
    statements: scan(out).statements.map((s) => s.text),
    variables,
    missing,
    ignoredMetaCommands: [...new Set(ignored)],
    defaults,
  };
}

function definedOnly(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined && v !== null));
}

// Lists variables a script needs, with the `\set` default when it has one.
export function listVariables(sql: string): { name: string; default?: string }[] {
  const prepared = prepareScript(sql);
  return prepared.variables.map((name) => ({ name, default: prepared.defaults[name] }));
}

export function statementAt(sql: string, offset: number): Statement | null {
  const { statements } = scan(sql);
  if (statements.length === 0) return null;
  let best = statements[0];
  for (const s of statements) {
    if (s.start <= offset) best = s;
  }
  return best;
}
