import { useEffect, useRef } from "react";
import { EditorView, basicSetup } from "codemirror";
import { keymap } from "@codemirror/view";
import { Compartment, EditorState, Prec } from "@codemirror/state";
import { indentWithTab } from "@codemirror/commands";
import { sql, PostgreSQL } from "@codemirror/lang-sql";
import { oneDark } from "@codemirror/theme-one-dark";

export interface EditorHandle {
  view: EditorView | null;
}

interface Props {
  doc: string;
  docKey: string;
  // Bumped when the script changed elsewhere (an agent, another tab, an editor)
  // and `doc` holds the new text to show.
  remoteRev: number;
  schema: Record<string, string[]>;
  dark: boolean;
  onChange: (doc: string) => void;
  onRun: () => void;
  onExplain: (analyze: boolean) => void;
  handle: EditorHandle;
}

export function Editor({ doc, docKey, remoteRev, schema, dark, onChange, onRun, onExplain, handle }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const language = useRef(new Compartment());
  const theme = useRef(new Compartment());
  const callbacks = useRef({ onChange, onRun, onExplain });
  callbacks.current = { onChange, onRun, onExplain };

  useEffect(() => {
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc,
        extensions: [
          Prec.highest(
            keymap.of([
              { key: "Mod-Enter", run: () => (callbacks.current.onRun(), true) },
              { key: "Mod-e", run: () => (callbacks.current.onExplain(false), true) },
              { key: "Mod-Shift-e", run: () => (callbacks.current.onExplain(true), true) },
            ]),
          ),
          basicSetup,
          keymap.of([indentWithTab]),
          language.current.of(sql({ dialect: PostgreSQL, schema, upperCaseKeywords: false })),
          theme.current.of(dark ? oneDark : []),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) callbacks.current.onChange(u.state.doc.toString());
          }),
        ],
      }),
    });
    handle.view = view;
    return () => {
      view.destroy();
      handle.view = null;
    };
    // The editor is rebuilt only when switching to another connection's script.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey]);

  useEffect(() => {
    handle.view?.dispatch({
      effects: language.current.reconfigure(sql({ dialect: PostgreSQL, schema, upperCaseKeywords: false })),
    });
  }, [schema, handle]);

  useEffect(() => {
    handle.view?.dispatch({ effects: theme.current.reconfigure(dark ? oneDark : []) });
  }, [dark, handle]);

  useEffect(() => {
    const view = handle.view;
    if (!view || view.state.doc.toString() === doc) return;
    const head = Math.min(view.state.selection.main.head, doc.length);
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: doc }, selection: { anchor: head } });
    // Only remote changes are pushed in; the user's own typing already matches.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remoteRev]);

  return <div className="editor" ref={host} />;
}
