// Renders an EXPLAIN (FORMAT JSON) plan in a layout close to psql's text
// format, so agents get readable plans from the one JSON run the browser also uses.

type Node = Record<string, unknown> & { Plans?: Node[] };

const DETAILS = ["Index Cond", "Recheck Cond", "Filter", "Rows Removed by Filter", "Join Filter", "Hash Cond", "Merge Cond", "Sort Key", "Sort Method", "Group Key", "Output"];

function line(node: Node): string {
  const parts = [String(node["Node Type"])];
  if (node["Join Type"] && String(node["Node Type"]).includes("Join")) parts.unshift(String(node["Join Type"]));
  if (node["Index Name"]) parts.push(`using ${node["Index Name"]}`);
  if (node["Relation Name"]) parts.push(`on ${node.Schema ? `${node.Schema}.` : ""}${node["Relation Name"]}${node.Alias && node.Alias !== node["Relation Name"] ? ` ${node.Alias}` : ""}`);
  let text = `${parts.join(" ")}  (cost=${node["Startup Cost"]}..${node["Total Cost"]} rows=${node["Plan Rows"]} width=${node["Plan Width"]})`;
  if (node["Actual Total Time"] !== undefined) {
    text += ` (actual time=${node["Actual Startup Time"]}..${node["Actual Total Time"]} rows=${node["Actual Rows"]} loops=${node["Actual Loops"]})`;
  }
  return text;
}

function render(node: Node, depth: number, out: string[]) {
  const pad = depth === 0 ? "" : `${"      ".repeat(depth - 1)}  ->  `;
  const detailPad = depth === 0 ? "  " : `${"      ".repeat(depth)}  `;
  out.push(pad + line(node));
  for (const key of DETAILS) {
    const v = node[key];
    if (v !== undefined) out.push(`${detailPad}${key}: ${Array.isArray(v) ? v.join(", ") : String(v)}`);
  }
  if (node["Shared Hit Blocks"] !== undefined) {
    out.push(`${detailPad}Buffers: shared hit=${node["Shared Hit Blocks"]} read=${node["Shared Read Blocks"] ?? 0}`);
  }
  for (const child of node.Plans ?? []) render(child, depth + 1, out);
}

export function planToText(plan: unknown): string {
  const root = (plan as Record<string, unknown>[])[0];
  const out: string[] = [];
  render(root.Plan as Node, 0, out);
  if (root["Planning Time"] !== undefined) out.push(`Planning Time: ${root["Planning Time"]} ms`);
  if (root["Execution Time"] !== undefined) out.push(`Execution Time: ${root["Execution Time"]} ms`);
  return out.join("\n");
}
