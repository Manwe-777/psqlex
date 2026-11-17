import { useEffect, useState } from "react";
import { api, type EditableProject, type PingResult } from "./api.ts";

interface Props {
  focusProject?: string;
  onClose: () => void;
  onSaved: (selectId?: string) => void;
}

const emptyConnection = () => ({ name: "local", url: "postgresql://postgres@localhost:5432/postgres", readOnly: false });

export function ConnectionsDialog({ focusProject, onClose, onSaved }: Props) {
  const [projects, setProjects] = useState<EditableProject[] | null>(null);
  const [paths, setPaths] = useState<{ readFrom: string; writesTo: string } | null>(null);
  const [tests, setTests] = useState<Record<string, PingResult | "testing">>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  // After adding a project, select its connection once saved.
  const [added, setAdded] = useState(false);

  useEffect(() => {
    api.config().then(
      ({ projects, readFrom, writesTo }) => {
        setProjects(projects);
        setPaths({ readFrom, writesTo });
      },
      (e) => setError(e.message),
    );
  }, []);

  useEffect(() => {
    if (focusProject) document.getElementById(`project-${focusProject}`)?.scrollIntoView();
  }, [projects, focusProject]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !dirty && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dirty, onClose]);

  const update = (fn: (draft: EditableProject[]) => void) => {
    setProjects((prev) => {
      const next = structuredClone(prev ?? []);
      fn(next);
      return next;
    });
    setDirty(true);
    setError(null);
  };

  const test = async (p: number, c: number) => {
    const conn = projects![p].connections[c];
    const key = `${p}.${c}`;
    setTests((t) => ({ ...t, [key]: "testing" }));
    const result = await api.testConnection({ url: conn.url, originalId: conn.originalId }).catch(
      (e): PingResult => ({ ok: false, error: e.message }),
    );
    setTests((t) => ({ ...t, [key]: result }));
  };

  const save = async () => {
    if (!projects) return;
    setSaving(true);
    try {
      const saved = await api.saveConfig(projects);
      setProjects(saved.projects);
      setPaths({ readFrom: saved.readFrom, writesTo: saved.writesTo });
      setDirty(false);
      const last = saved.projects.at(-1);
      onSaved(added && last ? `${last.name}/${last.connections.at(-1)!.name}` : undefined);
      setAdded(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && !dirty && onClose()}>
      <div className="dialog" role="dialog" aria-label="Connections">
        <div className="dialog-head">
          <strong>Connections</strong>
          {paths && (
            <span className="muted small">
              {paths.readFrom === paths.writesTo ? `Saved in ${paths.writesTo}` : `Showing ${paths.readFrom} · saving creates ${paths.writesTo}`}
            </span>
          )}
          <div className="spacer" />
          <button onClick={onClose}>{dirty ? "Discard" : "Close"}</button>
          <button className="primary" onClick={save} disabled={!dirty || saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
        {error && <div className="error pad">{error}</div>}
        <div className="dialog-body">
          {!projects && !error && <div className="muted pad">Loading…</div>}
          {projects?.map((project, p) => (
            <section className="project-card" key={p} id={`project-${project.name}`}>
              <div className="project-row">
                <label>
                  Project
                  <input value={project.name} placeholder="my-project" onChange={(e) => update((d) => void (d[p].name = e.target.value))} />
                </label>
                <label className="grow">
                  Notes
                  <input
                    value={project.description ?? ""}
                    placeholder="How to start its database, e.g. docker compose up db"
                    onChange={(e) => update((d) => void (d[p].description = e.target.value))}
                  />
                </label>
                <button className="danger" title="Remove project" onClick={() => update((d) => void d.splice(p, 1))}>
                  Remove project
                </button>
              </div>
              <table className="conn-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>URL</th>
                    <th title="Runs inside a transaction that cannot write">Read-only</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {project.connections.map((conn, c) => {
                    const result = tests[`${p}.${c}`];
                    return (
                      <tr key={c}>
                        <td>
                          <input className="conn-name" value={conn.name} onChange={(e) => update((d) => void (d[p].connections[c].name = e.target.value))} />
                        </td>
                        <td className="grow">
                          <input
                            className="conn-url"
                            value={conn.url}
                            spellCheck={false}
                            placeholder="postgresql://user:${PASSWORD_VAR}@host:5432/database"
                            onChange={(e) => update((d) => void (d[p].connections[c].url = e.target.value))}
                          />
                          {result && (
                            <div className={`small ${result === "testing" ? "muted" : result.ok ? "ok-text" : "error"}`}>
                              {result === "testing" ? "Testing…" : result.ok ? `Connected: ${result.database} as ${result.user}, pg ${result.version}` : result.error}
                            </div>
                          )}
                        </td>
                        <td className="center">
                          <input
                            type="checkbox"
                            checked={Boolean(conn.readOnly)}
                            onChange={(e) => update((d) => void (d[p].connections[c].readOnly = e.target.checked))}
                          />
                        </td>
                        <td className="nowrap">
                          <button onClick={() => test(p, c)}>Test</button>{" "}
                          <button
                            title="Remove connection"
                            disabled={project.connections.length === 1}
                            onClick={() => update((d) => void d[p].connections.splice(c, 1))}
                          >
                            ✕
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <button onClick={() => update((d) => void d[p].connections.push({ ...emptyConnection(), name: "" }))}>+ Connection</button>
            </section>
          ))}
          {projects && (
            <button
              className="add-project"
              onClick={() => {
                update((d) => void d.push({ name: "", connections: [emptyConnection()] }));
                setAdded(true);
                setTimeout(() => document.querySelector(".project-card:last-of-type input")?.scrollIntoView(), 0);
              }}
            >
              + Project
            </button>
          )}
          <p className="muted small pad">
            A password shown as <code>***</code> is kept as stored. Write <code>{"${VAR}"}</code> in a URL to read it from the
            environment psqlex was started with, so the password never lands in the file.
          </p>
        </div>
      </div>
    </div>
  );
}
