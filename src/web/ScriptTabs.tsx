import { useState } from "react";

interface Props {
  names: string[];
  active: string | null;
  unseen: Set<string>;
  saving: boolean;
  onSelect: (name: string) => void;
  onCreate: () => void;
  onRename: (from: string, to: string) => void;
  onDelete: (name: string) => void;
}

export function ScriptTabs({ names, active, unseen, saving, onSelect, onCreate, onRename, onDelete }: Props) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  // Deleting removes the .sql file, so the × asks once more in place.
  const [confirming, setConfirming] = useState<string | null>(null);

  const finishRename = () => {
    if (renaming && draft.trim() && draft.trim() !== renaming) onRename(renaming, draft.trim());
    setRenaming(null);
  };

  return (
    <nav className="script-tabs">
      {names.map((name) => (
        <div key={name} className={`script-tab ${name === active ? "active" : ""}`}>
          {renaming === name ? (
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={finishRename}
              onKeyDown={(e) => {
                if (e.key === "Enter") finishRename();
                if (e.key === "Escape") setRenaming(null);
              }}
            />
          ) : (
            <button
              className="script-tab-name"
              onClick={() => onSelect(name)}
              onDoubleClick={() => {
                setRenaming(name);
                setDraft(name);
              }}
              title="Double-click to rename"
            >
              {unseen.has(name) && <span className="dot" title="Changed since you last looked" />}
              {name}
            </button>
          )}
          <button
            className={`script-tab-close ${confirming === name ? "confirm" : ""}`}
            title={confirming === name ? "Click again to delete this script" : "Delete script"}
            onClick={() => (confirming === name ? (setConfirming(null), onDelete(name)) : setConfirming(name))}
            onBlur={() => setConfirming(null)}
          >
            {confirming === name ? "delete?" : "×"}
          </button>
        </div>
      ))}
      <button className="script-tab-new" title="New script" onClick={onCreate}>
        +
      </button>
      <span className="muted small script-tab-status">{saving ? "saving…" : ""}</span>
    </nav>
  );
}
