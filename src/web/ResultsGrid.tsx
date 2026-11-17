import { useState } from "react";
import type { RunResult } from "./api.ts";

type StatementResult = RunResult["results"][number];

function toCsv(r: StatementResult, sep: string): string {
  const cell = (v: string | null) => {
    if (v === null) return "";
    return /[",\n\t]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  };
  return [r.columns.map((c) => cell(c.name)).join(sep), ...r.rows.map((row) => row.map(cell).join(sep))].join("\n");
}

function toJson(r: StatementResult): string {
  return JSON.stringify(
    r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c.name, row[i]]))),
    null,
    2,
  );
}

export function ResultsGrid({ result }: { result: StatementResult }) {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async (label: string, text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(null), 1200);
  };

  const summary = [
    result.command,
    result.rowCount !== null ? `${result.rowCount} row${result.rowCount === 1 ? "" : "s"}` : `first ${result.rows.length} rows`,
    `${result.durationMs} ms`,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="grid-wrap">
      <div className="grid-bar">
        <span className={result.truncated ? "warn" : "muted"}>
          {summary}
          {result.truncated && " (truncated — raise ui.maxRows in the config for more)"}
        </span>
        {result.columns.length > 0 && (
          <span className="grid-actions">
            <button onClick={() => copy("tsv", toCsv(result, "\t"))}>{copied === "tsv" ? "Copied" : "Copy TSV"}</button>
            <button onClick={() => copy("csv", toCsv(result, ","))}>{copied === "csv" ? "Copied" : "Copy CSV"}</button>
            <button onClick={() => copy("json", toJson(result))}>{copied === "json" ? "Copied" : "Copy JSON"}</button>
          </span>
        )}
      </div>
      {result.columns.length > 0 ? (
        <div className="grid-scroll">
          <table className="grid">
            <thead>
              <tr>
                <th className="rownum">#</th>
                {result.columns.map((c, i) => (
                  <th key={i}>
                    <div>{c.name}</div>
                    <div className="coltype">{c.type}</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row, r) => (
                <tr key={r}>
                  <td className="rownum">{r + 1}</td>
                  {row.map((v, i) =>
                    v === null ? (
                      <td key={i} className="null">
                        NULL
                      </td>
                    ) : (
                      <td key={i} title={v.length > 60 ? v : undefined}>
                        {v.length > 300 ? `${v.slice(0, 300)}…` : v}
                      </td>
                    ),
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <pre className="sql-echo">{result.sql}</pre>
      )}
    </div>
  );
}
