import type { Connection } from "./config.ts";
import { explain, runScript, type ExplainResult, type QueryError, type RunResult } from "./db.ts";
import type { RunRecord, ScriptStore } from "./scripts.ts";
import { newRunId, RunHistory, toEntry } from "./history.ts";
import { scan } from "../shared/sql.ts";

export interface RunRequest {
  connection: Connection;
  sql: string;
  kind: "run" | "explain";
  analyze?: boolean;
  values?: Record<string, string>;
  readOnly: boolean;
  maxRows: number;
  statementTimeoutMs: number;
  runId?: string;
  source: RunRecord["source"];
  // When set, the run is saved as this script's last run, which the browser shows.
  script?: string;
}

export interface RunOutcome {
  // Id of this run in the history (list_runs / get_run).
  historyId: string;
  record: RunRecord;
  result?: RunResult | ExplainResult;
  error?: QueryError;
}

export async function runAndRecord(store: ScriptStore, req: RunRequest): Promise<RunOutcome> {
  const record: RunRecord = {
    source: req.source,
    kind: req.kind,
    analyze: req.kind === "explain" ? Boolean(req.analyze) : undefined,
    at: new Date().toISOString(),
    sql: req.sql,
    values: req.values && Object.keys(req.values).length ? req.values : undefined,
  };
  let outcome: RunOutcome;
  try {
    const result =
      req.kind === "run"
        ? await runScript(req.connection, req.sql, {
            values: req.values,
            readOnly: req.readOnly,
            maxRows: req.maxRows,
            statementTimeoutMs: req.statementTimeoutMs,
            runId: req.runId,
          })
        : await explain(req.connection, req.sql, {
            values: req.values,
            analyze: req.analyze,
            readOnly: req.readOnly,
            statementTimeoutMs: req.statementTimeoutMs,
            runId: req.runId,
          });
    record.result = result;
    outcome = { historyId: "", record, result };
  } catch (err) {
    const error: QueryError = (err as { queryError?: QueryError }).queryError ?? { message: (err as Error).message || String(err) };
    record.error = error;
    outcome = { historyId: "", record, error };
  }
  if (req.script) store.saveRun(req.connection.id, req.script, record);
  outcome.historyId = newRunId(record.at);
  try {
    new RunHistory(store.root).append(toEntry(req.connection.id, req.script, record, outcome.historyId));
  } catch (err) {
    // History is a debugging aid; failing to write it must not fail the run.
    console.error(`[psqlex] could not write run history: ${(err as Error).message}`);
  }
  return outcome;
}

// The text to explain for statement `index` (1-based) of a script, keeping the
// script's \set lines so its variables still have their defaults.
export function statementForExplain(script: string, index?: number): string {
  const { statements, metas } = scan(script);
  if (statements.length === 0) throw new Error("The script has no statements");
  if (index === undefined && statements.length > 1) {
    throw new Error(`The script has ${statements.length} statements; pass statement (1 to ${statements.length}) to choose one`);
  }
  const chosen = statements[(index ?? 1) - 1];
  if (!chosen) throw new Error(`The script has no statement ${index}; it has ${statements.length}`);
  const sets = metas.filter((m) => m.command === "set").map((m) => script.slice(m.start, m.end));
  return [...sets, chosen.text].join("\n");
}
