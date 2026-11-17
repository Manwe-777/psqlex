import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  ApiError,
  type ConnectionInfo,
  type ExplainResult,
  type PingResult,
  type QueryError,
  type RunRecord,
  type RunResult,
  type SchemaTable,
  type Script,
  type StoreEvent,
} from "./api.ts";
import { Editor, type EditorHandle } from "./Editor.tsx";
import { ResultsGrid } from "./ResultsGrid.tsx";
import { PlanView } from "./PlanView.tsx";
import { SchemaTree } from "./SchemaTree.tsx";
import { ConnectionsDialog } from "./ConnectionsDialog.tsx";
import { ScriptTabs } from "./ScriptTabs.tsx";
import { listVariables, statementAt } from "../shared/sql.ts";

const store = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(`psqlex.${key}`);
    } catch {
      return null;
    }
  },
  set(key: string, value: string) {
    try {
      localStorage.setItem(`psqlex.${key}`, value);
    } catch {
      /* storage unavailable */
    }
  },
};

const SAMPLE = `-- psql variables: \\set gives a default, the panel on the right overrides it.
\\set min_id 1

select :min_id as min_id, now() as at, current_database();
`;

type Output =
  | { kind: "run"; result: RunResult }
  | { kind: "explain"; result: ExplainResult }
  | { kind: "error"; error: QueryError };

function useDarkMode() {
  const query = window.matchMedia("(prefers-color-scheme: dark)");
  const [dark, setDark] = useState(query.matches);
  useEffect(() => {
    const on = (e: MediaQueryListEvent) => setDark(e.matches);
    query.addEventListener("change", on);
    return () => query.removeEventListener("change", on);
  }, [query]);
  return dark;
}

function ErrorView({ error }: { error: QueryError }) {
  let caret: { line: string; col: number } | null = null;
  if (error.sql && error.position) {
    const before = error.sql.slice(0, error.position - 1);
    const lineStart = before.lastIndexOf("\n") + 1;
    const lineEnd = error.sql.indexOf("\n", lineStart);
    caret = { line: error.sql.slice(lineStart, lineEnd === -1 ? undefined : lineEnd), col: before.length - lineStart };
  }
  return (
    <div className="error-view">
      <div className="error">
        {error.code && <span className="muted">[{error.code}] </span>}
        {error.message}
      </div>
      {error.detail && <div><b>Detail:</b> {error.detail}</div>}
      {error.hint && <div><b>Hint:</b> {error.hint}</div>}
      {caret && (
        <pre className="sql-echo">
          {caret.line}
          {"\n"}
          {" ".repeat(caret.col)}^
        </pre>
      )}
      {error.statementIndex !== undefined && <div className="muted">in statement {error.statementIndex + 1}</div>}
    </div>
  );
}

function toOutput(record: RunRecord): Output {
  if (record.error) return { kind: "error", error: record.error as QueryError };
  if (record.kind === "explain") return { kind: "explain", result: record.result as ExplainResult };
  return { kind: "run", result: record.result as RunResult };
}

interface ShownRun {
  output: Output;
  source: RunRecord["source"];
  at: string;
}

const shown = (record: RunRecord): ShownRun => ({ output: toOutput(record), source: record.source, at: record.at });

function ago(iso: string): string {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return new Date(iso).toLocaleString();
}

// How long after the user's last keystroke "follow agent" may switch tabs.
const IDLE_MS = 4000;

export function App() {
  const dark = useDarkMode();
  const [connections, setConnections] = useState<ConnectionInfo[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string>(() => store.get("connection") ?? "");
  const [status, setStatus] = useState<PingResult | null>(null);
  const [schema, setSchema] = useState<SchemaTable[] | null>(null);
  const [schemaError, setSchemaError] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>(() => JSON.parse(store.get("values") ?? "{}"));
  const [readOnly, setReadOnly] = useState(false);
  const [running, setRunning] = useState<{ runId: string; label: string } | null>(null);
  const [tab, setTab] = useState(0);
  const [editing, setEditing] = useState<{ project?: string } | null>(null);
  const editor = useRef<EditorHandle>({ view: null }).current;

  // Scripts of the selected connection. Each is a .sql file on the server.
  const [names, setNames] = useState<string[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [doc, setDoc] = useState("");
  const [remoteRev, setRemoteRev] = useState(0);
  const [runs, setRuns] = useState<Record<string, ShownRun>>({});
  const [unseen, setUnseen] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [follow, setFollow] = useState(() => store.get("follow") !== "false");

  // Mutable state the event stream and timers read without re-subscribing.
  const sync = useRef({
    selected: "",
    active: null as string | null,
    version: undefined as string | undefined,
    content: "",
    saveTimer: undefined as ReturnType<typeof setTimeout> | undefined,
    lastTyped: 0,
    follow: true,
    pendingActive: null as string | null,
  }).current;
  sync.selected = selected;
  sync.active = active;
  sync.follow = follow;

  const connection = connections.find((c) => c.id === selected);

  const loadConnections = useCallback((selectId?: string) => {
    api
      .connections()
      .then(({ connections }) => {
        setLoadError(null);
        setConnections(connections);
        setSelected((current) => {
          const want = selectId ?? current;
          return connections.some((c) => c.id === want) ? want : (connections[0]?.id ?? "");
        });
      })
      .catch((e) => setLoadError(e.message));
  }, []);

  useEffect(() => loadConnections(), [loadConnections]);

  const loadSchema = useCallback((id: string) => {
    setSchema(null);
    setSchemaError(null);
    api.schema(id).then(setSchema, (e) => setSchemaError(e.message));
  }, []);

  const openScript = useCallback(async (connectionId: string, name: string) => {
    const script = await api.script(connectionId, name);
    if (sync.selected !== connectionId) return;
    sync.version = script.version;
    sync.content = script.content;
    setActive(name);
    setDoc(script.content);
    setUnseen((u) => {
      const next = new Set(u);
      next.delete(name);
      return next;
    });
    if (script.lastRun) setRuns((r) => ({ ...r, [name]: shown(script.lastRun!) }));
    store.set(`script.${connectionId}`, name);
    setTab(0);
  }, [sync]);

  // Loads the connection's scripts. A connection with none gets a "main"
  // script, seeded from what older versions kept in the browser.
  const loadScripts = useCallback(async (connectionId: string) => {
    let list = await api.scripts(connectionId);
    if (list.length === 0) {
      const legacy = store.get(`doc.${connectionId}`);
      await api.saveScript(connectionId, "main", legacy ?? SAMPLE, undefined, true).catch(() => {});
      try {
        localStorage.removeItem(`psqlex.doc.${connectionId}`);
      } catch {
        /* storage unavailable */
      }
      list = await api.scripts(connectionId);
    }
    if (sync.selected !== connectionId) return;
    setNames(list.map((s) => s.name));
    setRuns(Object.fromEntries(list.filter((s) => s.lastRun).map((s) => [s.name, shown(s.lastRun!)])));
    setUnseen(new Set());
    const want = sync.pendingActive ?? store.get(`script.${connectionId}`);
    sync.pendingActive = null;
    const pick = list.find((s) => s.name === want)?.name ?? list[0]?.name;
    if (pick) await openScript(connectionId, pick);
  }, [openScript, sync]);

  useEffect(() => {
    if (!selected) return;
    store.set("connection", selected);
    setReadOnly(connections.find((c) => c.id === selected)?.readOnly ?? false);
    setStatus(null);
    setNames([]);
    setActive(null);
    setRuns({});
    void loadScripts(selected).catch((e) => setNotice(`Could not load scripts: ${e.message}`));
    api.ping(selected).then((s) => {
      setStatus(s);
      if (s.ok) loadSchema(selected);
      else setSchema([]);
    });
  }, [selected, connections, loadSchema, loadScripts]);

  const save = useCallback(async () => {
    const connectionId = sync.selected;
    const name = sync.active;
    if (!connectionId || !name) return;
    const content = sync.content;
    setSaving(true);
    try {
      const saved = await api.saveScript(connectionId, name, content, sync.version);
      if (sync.active === name) sync.version = saved.version;
    } catch (e) {
      // Someone else changed the script since we loaded it: show their version.
      if (e instanceof ApiError && e.status === 409) {
        const current = (e.body as { current?: Script }).current;
        if (current && sync.active === name) {
          sync.version = current.version;
          sync.content = current.content;
          setDoc(current.content);
          setRemoteRev((r) => r + 1);
          setNotice(`"${name}" was changed elsewhere while you typed; showing the newer version.`);
        }
      } else {
        setNotice(`Could not save "${name}": ${(e as Error).message}`);
      }
    } finally {
      setSaving(false);
    }
  }, [sync]);

  const onChange = useCallback(
    (text: string) => {
      setDoc(text);
      if (text === sync.content) return;
      sync.content = text;
      sync.lastTyped = Date.now();
      clearTimeout(sync.saveTimer);
      sync.saveTimer = setTimeout(() => {
        sync.saveTimer = undefined;
        void save();
      }, 400);
    },
    [save, sync],
  );

  // Saves a pending edit before switching away from a script.
  const flush = useCallback(async () => {
    if (sync.saveTimer) {
      clearTimeout(sync.saveTimer);
      sync.saveTimer = undefined;
      await save();
    }
  }, [save, sync]);

  const idle = () => Date.now() - sync.lastTyped > IDLE_MS;

  // Live changes from the server: script edits and runs by anyone.
  useEffect(() => {
    const events = new EventSource("/api/events");
    const onScript = (e: MessageEvent) => {
      const ev = JSON.parse(e.data) as Extract<StoreEvent, { type: "script" }>;
      if (ev.connection !== sync.selected) {
        if (sync.follow && idle() && connections.some((c) => c.id === ev.connection)) {
          sync.pendingActive = ev.name;
          setSelected(ev.connection);
        }
        return;
      }
      setNames((n) => (n.includes(ev.name) ? n : [...n, ev.name].sort((a, b) => a.localeCompare(b))));
      if (ev.name === sync.active) {
        if (ev.version === sync.version || ev.content === sync.content) return;
        if (sync.saveTimer) return; // our pending save will get a 409 and take this version
        sync.version = ev.version;
        sync.content = ev.content;
        setDoc(ev.content);
        setRemoteRev((r) => r + 1);
      } else if (sync.follow && idle()) {
        void flush().then(() => openScript(ev.connection, ev.name));
      } else {
        setUnseen((u) => new Set(u).add(ev.name));
      }
    };
    const onDeleted = (e: MessageEvent) => {
      const ev = JSON.parse(e.data) as Extract<StoreEvent, { type: "script-deleted" }>;
      if (ev.connection !== sync.selected) return;
      setNames((n) => {
        const next = n.filter((x) => x !== ev.name);
        if (ev.name === sync.active && next[0]) void openScript(ev.connection, next[0]);
        if (ev.name === sync.active && !next[0]) setActive(null);
        return next;
      });
    };
    const onRun = (e: MessageEvent) => {
      const ev = JSON.parse(e.data) as Extract<StoreEvent, { type: "run" }>;
      if (ev.connection !== sync.selected) return;
      setRuns((r) => ({ ...r, [ev.name]: shown(ev.run) }));
      if (ev.run.source !== "agent") return;
      // Show the values the agent ran with, so the panel matches what was tested.
      const agentValues = ev.run.values;
      if (agentValues) {
        setValues((v) => {
          const next = { ...v, ...agentValues };
          store.set("values", JSON.stringify(next));
          return next;
        });
      }
      if (ev.name === sync.active) setTab(0);
      else if (sync.follow && idle()) void flush().then(() => openScript(ev.connection, ev.name));
      else setUnseen((u) => new Set(u).add(ev.name));
    };
    events.addEventListener("script", onScript);
    events.addEventListener("script-deleted", onDeleted);
    events.addEventListener("run", onRun);
    return () => events.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connections, flush, openScript, sync]);

  const selectScript = async (name: string) => {
    if (name === active) return;
    await flush();
    await openScript(selected, name);
  };

  const createScript = async () => {
    await flush();
    let n = names.length + 1;
    while (names.includes(`script ${n}`)) n++;
    const name = `script ${n}`;
    await api.saveScript(selected, name, "", undefined, true);
    setNames((list) => (list.includes(name) ? list : [...list, name].sort((a, b) => a.localeCompare(b))));
    await openScript(selected, name);
  };

  const renameScript = async (from: string, to: string) => {
    await flush();
    try {
      const renamed = await api.renameScript(selected, from, to);
      setNames((list) => list.map((x) => (x === from ? renamed.name : x)).sort((a, b) => a.localeCompare(b)));
      setRuns((r) => {
        const { [from]: moved, ...rest } = r;
        return moved ? { ...rest, [renamed.name]: moved } : rest;
      });
      if (active === from) await openScript(selected, renamed.name);
    } catch (e) {
      setNotice((e as Error).message);
    }
  };

  const deleteScript = async (name: string) => {
    if (name === active) {
      clearTimeout(sync.saveTimer);
      sync.saveTimer = undefined;
    }
    await api.deleteScript(selected, name);
    const rest = names.filter((x) => x !== name);
    setNames(rest);
    if (name === active) {
      if (rest[0]) await openScript(selected, rest[0]);
      else await loadScripts(selected);
    }
  };

  const toggleFollow = (on: boolean) => {
    setFollow(on);
    store.set("follow", String(on));
  };

  const variables = useMemo(() => listVariables(doc), [doc]);

  const setValue = (name: string, value: string) => {
    const next = { ...values, [name]: value };
    setValues(next);
    store.set("values", JSON.stringify(next));
  };

  // \set defaults from the whole script apply even when only a selection runs.
  const effectiveValues = () => {
    const out: Record<string, string> = {};
    for (const v of variables) {
      const value = values[v.name] !== undefined && values[v.name] !== "" ? values[v.name] : v.default;
      if (value !== undefined) out[v.name] = value;
    }
    return out;
  };

  const schemaCompletion = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const t of schema ?? []) out[t.schema === "public" ? t.name : `${t.schema}.${t.name}`] = t.columns.map((c) => c.name);
    return out;
  }, [schema]);

  const selection = () => {
    const view = editor.view;
    if (!view) return { text: doc, cursor: 0, hasSelection: false };
    const { from, to } = view.state.selection.main;
    return { text: view.state.sliceDoc(from, to), cursor: from, hasSelection: from !== to };
  };

  const execute = async (label: string, fn: (runId: string) => Promise<Output>) => {
    if (!connection || running || !active) return;
    const name = active;
    const runId = crypto.randomUUID();
    setRunning({ runId, label });
    const record = (output: Output) => setRuns((r) => ({ ...r, [name]: { output, source: "ui", at: new Date().toISOString() } }));
    try {
      await flush();
      const out = await fn(runId);
      record(out);
      // Open the error tab when a statement failed after earlier ones succeeded.
      setTab(out.kind === "run" && out.result.error ? out.result.results.length : 0);
    } catch (e) {
      record({ kind: "error", error: e instanceof ApiError ? e.error : { message: String(e) } });
      setTab(0);
    } finally {
      setRunning(null);
    }
  };

  const run = () => {
    const sel = selection();
    const sql = sel.hasSelection ? sel.text : doc;
    void execute("Running", async (runId) => ({
      kind: "run",
      result: await api.run({ connection: connection!.id, sql, values: effectiveValues(), runId, readOnly, script: active ?? undefined }),
    }));
  };

  const runExplain = (analyze: boolean) => {
    const sel = selection();
    const sql = sel.hasSelection ? sel.text : (statementAt(doc, sel.cursor)?.text ?? "");
    void execute(analyze ? "Analyzing" : "Explaining", async (runId) => ({
      kind: "explain",
      result: await api.explain({ connection: connection!.id, sql, values: effectiveValues(), analyze, runId, readOnly, script: active ?? undefined }),
    }));
  };

  const insert = (text: string) => {
    const view = editor.view;
    if (!view) return;
    const { from, to } = view.state.selection.main;
    view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } });
    view.focus();
  };

  const current = active ? runs[active] : undefined;
  const output = current?.output ?? null;

  const projects = useMemo(() => {
    const map = new Map<string, ConnectionInfo[]>();
    for (const c of connections) map.set(c.project, [...(map.get(c.project) ?? []), c]);
    return [...map.entries()];
  }, [connections]);

  const tabs: { label: string; body: React.ReactNode; error?: boolean }[] = [];
  if (output?.kind === "run") {
    output.result.results.forEach((r, i) =>
      tabs.push({ label: `${i + 1}. ${r.command ?? "result"}${r.columns.length ? ` (${r.rowCount ?? `${r.rows.length}+`})` : ""}`, body: <ResultsGrid result={r} /> }),
    );
    if (output.result.error) tabs.push({ label: "Error", body: <ErrorView error={output.result.error} />, error: true });
    const messages = [
      ...output.result.notices,
      ...(output.result.ignoredMetaCommands.length ? [`Ignored psql meta-commands: ${output.result.ignoredMetaCommands.join(" ")}`] : []),
      `${output.result.readOnly ? "Ran read-only, rolled back" : "Ran with autocommit"} · total ${output.result.durationMs} ms`,
    ];
    tabs.push({ label: "Messages", body: <pre className="sql-echo">{messages.join("\n")}</pre> });
  } else if (output?.kind === "explain") {
    tabs.push({ label: output.result.analyze ? "Explain analyze" : "Explain", body: <PlanView result={output.result} /> });
    tabs.push({ label: "Statement", body: <pre className="sql-echo">{output.result.sql}</pre> });
  } else if (output?.kind === "error") {
    tabs.push({ label: "Error", body: <ErrorView error={output.error} />, error: true });
  }
  const activeTab = Math.min(tab, Math.max(0, tabs.length - 1));

  return (
    <div className="app">
      <header>
        <span className="logo">psqlex</span>
        <select value={selected} onChange={(e) => setSelected(e.target.value)}>
          {projects.map(([project, conns]) => (
            <optgroup key={project} label={project}>
              {conns.map((c) => (
                <option key={c.id} value={c.id}>
                  {project} / {c.name}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <button title="Add, edit or remove connections" onClick={() => setEditing({ project: connection?.project })}>
          Connections
        </button>
        <span className={`status ${status === null ? "" : status.ok ? "ok" : "down"}`} title={status?.error ?? connection?.url}>
          {status === null ? "connecting…" : status.ok ? `${status.database} · pg ${status.version}` : "unreachable"}
        </span>
        <label className="ro" title="Run inside a read-only transaction that is rolled back">
          <input type="checkbox" checked={readOnly} disabled={connection?.readOnly} onChange={(e) => setReadOnly(e.target.checked)} />
          read-only
        </label>
        <label className="ro" title="Switch to the script an agent edits or runs (after a few seconds without typing)">
          <input type="checkbox" checked={follow} onChange={(e) => toggleFollow(e.target.checked)} />
          follow agent
        </label>
        <div className="spacer" />
        <button className="primary" onClick={run} disabled={!!running || !status?.ok || !active} title="⌘↵ — runs the selection, or the whole script">
          Run
        </button>
        <button onClick={() => runExplain(false)} disabled={!!running || !status?.ok} title="⌘E — the selection, or the statement at the cursor">
          Explain
        </button>
        <button onClick={() => runExplain(true)} disabled={!!running || !status?.ok} title="⌘⇧E — executes the statement inside a rolled-back transaction">
          Analyze
        </button>
        {running && (
          <button className="danger" onClick={() => api.cancel(running.runId)}>
            Cancel
          </button>
        )}
      </header>
      {loadError && <div className="error pad">Could not load connections: {loadError}</div>}
      {!loadError && connections.length === 0 && (
        <div className="banner">
          No connections yet. <button onClick={() => setEditing({})}>Add one</button>
        </div>
      )}
      {editing && (
        <ConnectionsDialog
          focusProject={editing.project}
          onClose={() => setEditing(null)}
          onSaved={(selectId) => loadConnections(selectId)}
        />
      )}
      {notice && (
        <div className="banner">
          {notice} <button onClick={() => setNotice(null)}>Dismiss</button>
        </div>
      )}
      {status && !status.ok && (
        <div className="banner">
          Cannot reach {connection?.url}: {status.error}
          {connection?.description && <span className="muted"> — {connection.description}</span>}
        </div>
      )}
      <div className="body">
        <SchemaTree tables={schema} error={schemaError} onInsert={insert} onRefresh={() => selected && loadSchema(selected)} />
        <main>
          <ScriptTabs
            names={names}
            active={active}
            unseen={unseen}
            saving={saving}
            onSelect={(name) => void selectScript(name)}
            onCreate={() => void createScript()}
            onRename={(from, to) => void renameScript(from, to)}
            onDelete={(name) => void deleteScript(name)}
          />
          <div className="top">
            {selected && active && (
              <Editor
                doc={doc}
                docKey={`${selected}::${active}`}
                remoteRev={remoteRev}
                schema={schemaCompletion}
                dark={dark}
                onChange={onChange}
                onRun={run}
                onExplain={runExplain}
                handle={editor}
              />
            )}
            {variables.length > 0 && (
              <div className="vars">
                <div className="vars-title">Variables</div>
                {variables.map((v) => (
                  <label key={v.name}>
                    <span>:{v.name}</span>
                    <input
                      value={values[v.name] ?? ""}
                      placeholder={v.default ?? "required"}
                      onChange={(e) => setValue(v.name, e.target.value)}
                      className={values[v.name] === undefined && v.default === undefined ? "missing" : ""}
                    />
                  </label>
                ))}
                <div className="muted small">
                  <code>:x</code> as written, <code>:'x'</code> quoted literal, <code>:"x"</code> identifier
                </div>
              </div>
            )}
          </div>
          <section className="output">
            {running ? (
              <div className="pad muted">{running.label}…</div>
            ) : tabs.length === 0 ? (
              <div className="pad muted">⌘↵ runs the script (or the selection). ⌘E explains the statement at the cursor, ⌘⇧E explain-analyzes it.</div>
            ) : (
              <>
                {current && (
                  <div className={`run-meta ${current.source}`}>
                    {current.source === "agent" ? "Run by an agent" : "Run from this page"} · {ago(current.at)}
                  </div>
                )}
                <nav className="tabs">
                  {tabs.map((t, i) => (
                    <button key={i} className={`${i === activeTab ? "active" : ""} ${t.error ? "error" : ""}`} onClick={() => setTab(i)}>
                      {t.label}
                    </button>
                  ))}
                </nav>
                <div className="tab-body">{tabs[activeTab].body}</div>
              </>
            )}
          </section>
        </main>
      </div>
    </div>
  );
}
