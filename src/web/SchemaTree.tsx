import { useMemo, useState } from "react";
import type { SchemaTable } from "./api.ts";

interface Props {
  tables: SchemaTable[] | null;
  error: string | null;
  onInsert: (text: string) => void;
  onRefresh: () => void;
}

export function SchemaTree({ tables, error, onInsert, onRefresh }: Props) {
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState<Set<string>>(new Set());

  const visible = useMemo(() => {
    const f = filter.trim().toLowerCase();
    if (!tables) return [];
    if (!f) return tables;
    return tables.filter((t) => t.name.toLowerCase().includes(f) || t.columns.some((c) => c.name.toLowerCase().includes(f)));
  }, [tables, filter]);

  const toggle = (key: string) => {
    const next = new Set(open);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setOpen(next);
  };

  return (
    <aside className="schema">
      <div className="schema-head">
        <input placeholder="Filter tables / columns" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <button title="Reload schema" onClick={onRefresh}>↻</button>
      </div>
      {error && <div className="error small">{error}</div>}
      {tables && tables.length === 0 && <div className="muted small pad">No tables</div>}
      <ul>
        {visible.map((t) => {
          const key = `${t.schema}.${t.name}`;
          const qualified = t.schema === "public" ? t.name : key;
          return (
            <li key={key}>
              <div className="schema-table">
                <button className="toggle" onClick={() => toggle(key)}>{open.has(key) ? "▾" : "▸"}</button>
                <span className="schema-name" title={`${t.kind} · double-click to insert`} onDoubleClick={() => onInsert(qualified)}>
                  {t.schema !== "public" && <span className="muted">{t.schema}.</span>}
                  {t.name}
                </span>
                {t.kind !== "table" && <span className="badge">{t.kind === "view" ? "view" : "mv"}</span>}
                {t.estimatedRows !== null && <span className="muted small">{t.estimatedRows.toLocaleString()}</span>}
              </div>
              {open.has(key) && (
                <ul className="columns">
                  {t.columns.map((c) => (
                    <li key={c.name} onDoubleClick={() => onInsert(c.name)} title={c.default ? `default ${c.default}` : undefined}>
                      <span>{c.name}</span>
                      <span className="muted small">
                        {c.type}
                        {c.nullable ? "" : " not null"}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
