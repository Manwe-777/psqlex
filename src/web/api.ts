import type { EditableProject } from "../server/config.ts";
import type { RunResult, ExplainResult, QueryError, PingResult, SchemaTable } from "../server/db.ts";
import type { RunRecord, Script, ScriptInfo, StoreEvent } from "../server/scripts.ts";

export type { EditableProject, RunResult, ExplainResult, QueryError, PingResult, SchemaTable, RunRecord, Script, ScriptInfo, StoreEvent };

export interface ConnectionInfo {
  id: string;
  project: string;
  name: string;
  url: string;
  readOnly: boolean;
  description?: string;
}

export interface ConfigResponse {
  projects: EditableProject[];
  readFrom: string;
  writesTo: string;
}

export class ApiError extends Error {
  constructor(
    public error: QueryError,
    public status = 0,
    public body: unknown = undefined,
  ) {
    super(error.message);
  }
}

async function call<T>(path: string, body?: unknown, method?: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    // fetch only rejects when no HTTP response came back at all.
    throw new ApiError({
      message: `Cannot reach the psqlex server at ${location.origin}. Is \`pnpm start\` still running? Check its terminal for a crash.`,
    });
  }
  const data = await res.json().catch(() => ({ error: { message: `${res.status} ${res.statusText}` } }));
  if (!res.ok) throw new ApiError(data.error ?? { message: res.statusText }, res.status, data);
  return data as T;
}

const enc = (id: string) => id.split("/").map(encodeURIComponent).join("/");

export const api = {
  connections: () => call<{ connections: ConnectionInfo[]; ui: { maxRows: number; statementTimeoutMs: number } }>("/api/connections"),
  ping: (id: string) => call<PingResult>(`/api/connections/${enc(id)}/ping`),
  schema: (id: string) => call<SchemaTable[]>(`/api/connections/${enc(id)}/schema`),
  run: (body: { connection: string; sql: string; values: Record<string, string>; runId: string; readOnly: boolean; script?: string }) =>
    call<RunResult>("/api/run", body),
  explain: (body: { connection: string; sql: string; values: Record<string, string>; analyze: boolean; runId: string; readOnly: boolean; script?: string }) =>
    call<ExplainResult>("/api/explain", body),
  scripts: (connection: string) => call<(ScriptInfo & { lastRun: RunRecord | null })[]>(`/api/scripts/${enc(connection)}`),
  script: (connection: string, name: string) =>
    call<Script & { lastRun: RunRecord | null }>(`/api/scripts/${enc(connection)}/${encodeURIComponent(name)}`),
  saveScript: (connection: string, name: string, content: string, baseVersion?: string, create = false) =>
    call<Script>(`/api/scripts/${enc(connection)}/${encodeURIComponent(name)}`, { content, baseVersion, create }, "PUT"),
  renameScript: (connection: string, name: string, to: string) =>
    call<Script>(`/api/scripts/${enc(connection)}/${encodeURIComponent(name)}/rename`, { to }),
  deleteScript: (connection: string, name: string) =>
    call<{ deleted: boolean }>(`/api/scripts/${enc(connection)}/${encodeURIComponent(name)}`, undefined, "DELETE"),
  config: () => call<ConfigResponse>("/api/config"),
  saveConfig: (projects: EditableProject[]) => call<ConfigResponse>("/api/config", { projects }, "PUT"),
  testConnection: (body: { url: string; originalId?: string }) => call<PingResult>("/api/test-connection", body),
  cancel: (runId: string) => call<{ cancelled: boolean }>(`/api/cancel/${runId}`, {}),
};
