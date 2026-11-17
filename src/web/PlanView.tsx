import { useState } from "react";
import type { ExplainResult } from "./api.ts";

interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  Schema?: string;
  Alias?: string;
  "Index Name"?: string;
  "Join Type"?: string;
  Strategy?: string;
  "Parent Relationship"?: string;
  "Subplan Name"?: string;
  "CTE Name"?: string;
  "Startup Cost": number;
  "Total Cost": number;
  "Plan Rows": number;
  "Plan Width": number;
  "Actual Rows"?: number;
  "Actual Loops"?: number;
  "Actual Total Time"?: number;
  "Shared Hit Blocks"?: number;
  "Shared Read Blocks"?: number;
  "Temp Read Blocks"?: number;
  "Temp Written Blocks"?: number;
  Plans?: PlanNode[];
  [key: string]: unknown;
}

interface PlanRoot {
  Plan: PlanNode;
  "Planning Time"?: number;
  "Execution Time"?: number;
  Triggers?: unknown[];
}

const DETAIL_KEYS = [
  "Index Cond",
  "Recheck Cond",
  "Filter",
  "Rows Removed by Filter",
  "Rows Removed by Index Recheck",
  "Join Filter",
  "Rows Removed by Join Filter",
  "Hash Cond",
  "Merge Cond",
  "Sort Key",
  "Sort Method",
  "Sort Space Used",
  "Group Key",
  "Hash Buckets",
  "Hash Batches",
  "Peak Memory Usage",
  "Workers Planned",
  "Workers Launched",
  "Heap Fetches",
  "Output",
];

// Time a node spent itself, without its children. Actual Total Time is per
// loop, so it is multiplied by loops before subtracting.
function selfTime(node: PlanNode): number | null {
  if (node["Actual Total Time"] === undefined) return null;
  const total = node["Actual Total Time"] * (node["Actual Loops"] ?? 1);
  const children = (node.Plans ?? [])
    .filter((p) => p["Parent Relationship"] !== "InitPlan")
    .reduce((sum, p) => sum + (p["Actual Total Time"] ?? 0) * (p["Actual Loops"] ?? 1), 0);
  return Math.max(0, total - children);
}

function estimateRatio(node: PlanNode): number | null {
  if (node["Actual Rows"] === undefined) return null;
  const actual = Math.max(node["Actual Rows"], 1);
  const planned = Math.max(node["Plan Rows"], 1);
  return actual / planned;
}

const fmt = (n: number) => (n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2));

function NodeView({ node, totalMs, maxCost, depth }: { node: PlanNode; totalMs: number | null; maxCost: number; depth: number }) {
  const [open, setOpen] = useState(true);
  const [showDetails, setShowDetails] = useState(false);
  const self = selfTime(node);
  const share = self !== null && totalMs ? self / totalMs : null;
  const ratio = estimateRatio(node);
  const badEstimate = ratio !== null && (ratio > 10 || ratio < 0.1);
  const target = [node["Relation Name"] && `${node.Schema ? `${node.Schema}.` : ""}${node["Relation Name"]}`, node["CTE Name"] && `CTE ${node["CTE Name"]}`]
    .filter(Boolean)
    .join("");
  const details = DETAIL_KEYS.filter((k) => node[k] !== undefined);
  const barShare = share ?? node["Total Cost"] / (maxCost || 1);

  return (
    <div className="plan-node" style={{ marginLeft: depth ? 18 : 0 }}>
      <div className={`plan-row ${share !== null && share > 0.3 ? "hot" : ""}`}>
        <button className="toggle" onClick={() => setOpen(!open)} disabled={!node.Plans?.length}>
          {node.Plans?.length ? (open ? "▾" : "▸") : "·"}
        </button>
        <div className="plan-main" onClick={() => setShowDetails(!showDetails)}>
          <div className="plan-title">
            {node["Subplan Name"] && <span className="muted">{node["Subplan Name"]} → </span>}
            <strong>{node["Join Type"] && node["Node Type"].includes("Join") ? `${node["Join Type"]} ` : ""}{node["Strategy"] && node["Node Type"] === "Aggregate" ? `${node["Strategy"]} ` : ""}{node["Node Type"]}</strong>
            {target && <span> on <code>{target}</code></span>}
            {node.Alias && node.Alias !== node["Relation Name"] && <span className="muted"> {node.Alias}</span>}
            {node["Index Name"] && <span> using <code>{node["Index Name"]}</code></span>}
          </div>
          <div className="plan-stats">
            {self !== null && (
              <span title="Time spent in this node, excluding children">
                <b>{fmt(self)} ms</b>
                {share !== null && ` (${(share * 100).toFixed(0)}%)`}
              </span>
            )}
            <span title="Estimated rows → actual rows">
              rows {node["Plan Rows"]}
              {node["Actual Rows"] !== undefined && (
                <>
                  {" → "}
                  <span className={badEstimate ? "warn" : ""}>{node["Actual Rows"]}</span>
                  {badEstimate && ` (${ratio! > 1 ? `${fmt(ratio!)}× under` : `${fmt(1 / ratio!)}× over`}-estimated)`}
                </>
              )}
            </span>
            {(node["Actual Loops"] ?? 1) > 1 && <span>loops {node["Actual Loops"]}</span>}
            <span className="muted">cost {node["Startup Cost"]}..{node["Total Cost"]}</span>
            {node["Shared Hit Blocks"] !== undefined && (
              <span className="muted" title="Shared buffers: hit in cache / read from disk">
                buffers {node["Shared Hit Blocks"]} hit / {node["Shared Read Blocks"] ?? 0} read
              </span>
            )}
            {(node["Temp Written Blocks"] ?? 0) > 0 && <span className="warn">temp {node["Temp Written Blocks"]} blocks written</span>}
          </div>
          <div className="plan-bar">
            <div style={{ width: `${Math.min(100, barShare * 100)}%` }} className={share !== null ? "time" : "cost"} />
          </div>
          {(showDetails || Boolean(node.Filter) || Boolean(node["Index Cond"])) && details.length > 0 && (
            <dl className="plan-details">
              {(showDetails ? details : details.filter((k) => k === "Filter" || k === "Index Cond" || k === "Rows Removed by Filter")).map((k) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd>{Array.isArray(node[k]) ? (node[k] as unknown[]).join(", ") : String(node[k])}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      </div>
      {open && node.Plans?.map((child, i) => <NodeView key={i} node={child} totalMs={totalMs} maxCost={maxCost} depth={depth + 1} />)}
    </div>
  );
}

export function PlanView({ result }: { result: ExplainResult }) {
  const [raw, setRaw] = useState(false);
  const root = (result.plan as PlanRoot[])[0];
  const totalMs = root["Execution Time"] ?? null;
  return (
    <div className="plan">
      <div className="grid-bar">
        <span className="muted">
          {result.analyze ? "EXPLAIN ANALYZE (rolled back)" : "EXPLAIN (estimates only)"}
          {root["Planning Time"] !== undefined && ` · planning ${fmt(root["Planning Time"])} ms`}
          {totalMs !== null && ` · execution ${fmt(totalMs)} ms`}
          {" · click a node for details"}
        </span>
        <span className="grid-actions">
          <button onClick={() => setRaw(!raw)}>{raw ? "Tree" : "Raw JSON"}</button>
          <button onClick={() => navigator.clipboard.writeText(JSON.stringify(result.plan, null, 2))}>Copy JSON</button>
        </span>
      </div>
      <div className="grid-scroll plan-scroll">
        {raw ? (
          <pre className="sql-echo">{JSON.stringify(result.plan, null, 2)}</pre>
        ) : (
          <NodeView node={root.Plan} totalMs={totalMs} maxCost={root.Plan["Total Cost"]} depth={0} />
        )}
      </div>
    </div>
  );
}
