import { useEffect, useRef, useState } from "react";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { Annotation, EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { computeChange } from "../editor/changes";
import { addHighlight, clearHighlights, editHighlights } from "../editor/highlight-extension";
import { cursorField, setCursorPos } from "../editor/cursor-extension";
import { markdownInline } from "../editor/markdown-extension";
import { randomWelcome } from "../util/welcome";
import { useAppStore, useStoreApi } from "../store/context";

// The document surface: a CodeMirror 6 plain-text/markdown editor. Reducer edits
// arrive as full-text updates on AppState; we turn each into a minimal CM change
// (so the yellow highlight lands precisely on what changed) and mark it External
// so our own updateListener does not echo it back as a user edit. Direct
// keyboard edits flow back into the store as live text. Scroll/visible-range is
// reported into AppState for scroll-aware voice commands.

const External = Annotation.define<boolean>();

function reportScroll(view: EditorView, setScroll: (s: {
  firstVisibleLine: number;
  lastVisibleLine: number;
  totalLines: number;
}) => void): void {
  try {
    const { from, to } = view.viewport;
    setScroll({
      firstVisibleLine: view.state.doc.lineAt(from).number,
      lastVisibleLine: view.state.doc.lineAt(to).number,
      totalLines: view.state.doc.lines,
    });
  } catch {
    // No layout in headless/jsdom -- scroll reporting is a no-op there.
  }
}

export function DocumentPanel() {
  const api = useStoreApi();
  const doc = useAppStore((s) => s.app.activeDocument);
  const cursor = useAppStore((s) => s.app.cursor);
  const scrollCommand = useAppStore((s) => s.scrollCommand);

  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const lastDocIdRef = useRef<string | null>(null);
  // A stable, randomly-framed welcome for the empty-document state.
  const [welcome] = useState(randomWelcome);

  // Create the editor once.
  useEffect(() => {
    if (!hostRef.current) return;
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: "",
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          EditorView.lineWrapping,
          editHighlights(),
          cursorField,
          markdownInline(),
          EditorView.updateListener.of((u) => {
            if (
              u.docChanged &&
              !u.transactions.some((t) => t.annotation(External))
            ) {
              api.getState().setDocumentText(u.state.doc.toString());
            }
            // A user click/selection (not our own external cursor sync) moves the
            // insertion point -- report it so dictation continues from there.
            if (
              u.selectionSet &&
              !u.transactions.some((t) => t.annotation(External))
            ) {
              api.getState().setCursor(u.state.selection.main.head);
            }
            if (u.docChanged || u.viewportChanged || u.geometryChanged) {
              reportScroll(u.view, api.getState().setDocumentScroll);
            }
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [api]);

  // Reconcile store text -> editor. A document switch replaces everything and
  // clears highlights; an in-place edit applies a minimal change and glows.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (!doc) {
      if (view.state.doc.length > 0) {
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: "" },
          annotations: External.of(true),
          effects: clearHighlights.of(),
        });
      }
      lastDocIdRef.current = null;
      return;
    }
    const current = view.state.doc.toString();
    if (doc.id !== lastDocIdRef.current) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: doc.text },
        annotations: External.of(true),
        effects: clearHighlights.of(),
      });
      lastDocIdRef.current = doc.id;
      return;
    }
    if (current === doc.text) return;
    const change = computeChange(current, doc.text);
    if (!change) return;
    view.dispatch({
      changes: change,
      annotations: External.of(true),
      effects: addHighlight.of({
        from: change.from,
        to: change.from + change.insert.length,
        at: Date.now(),
      }),
    });
  }, [doc]);

  // Reflect the store's cursor (moved by AI edits / place_cursor / a load) as the
  // blue insertion line. Depends on text too, so it re-syncs after any edit. Marked
  // External so it never echoes back through the selection listener.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    // No document open -> no cursor (-1 clears the blue line).
    view.dispatch({
      effects: setCursorPos.of(doc ? cursor : -1),
      annotations: External.of(true),
    });
  }, [cursor, doc]);

  // Voice-driven scroll commands.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !scrollCommand || scrollCommand.target !== "document") return;
    const dom = view.scrollDOM;
    const step =
      scrollCommand.amount === "page"
        ? dom.clientHeight * 0.9 || 400
        : view.defaultLineHeight || 20;
    dom.scrollBy({ top: scrollCommand.direction === "down" ? step : -step });
  }, [scrollCommand]);

  return (
    <div className="flex h-full flex-col">
      {doc && (
        <div className="border-b border-gray-200 px-4 py-2 dark:border-gray-800">
          <DocumentTitle name={doc.name} />
        </div>
      )}
      <div className="relative flex-1 overflow-hidden">
        <div
          ref={hostRef}
          // The editable document region. CodeMirror renders its own textbox
          // inside; labelling the region names it for assistive tech.
          role="region"
          aria-label={doc ? `Document: ${doc.name}` : "Document editor"}
          className="qa-document-editor h-full overflow-auto"
        />
        {!doc && (
          // No document open: a centered welcome card over the (empty) editor.
          <div className="absolute inset-0 flex items-center justify-center p-6">
            <div className="qa-welcome max-w-md rounded-xl border border-gray-500/40 bg-gray-800 px-6 py-5 text-center shadow-lg dark:border-gray-600">
              <div className="mb-1.5 text-base font-semibold text-gray-100">
                {welcome.title}
              </div>
              <div className="text-sm leading-relaxed text-gray-300">
                {welcome.body}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// The document title, click-to-rename. Clicking the name swaps in a text field;
// Enter or blur commits a rename_document action (same path the AI uses), Escape
// cancels. Keeps the mouse-free promise intact -- voice rename still works too.
function DocumentTitle({ name }: { name: string }) {
  const api = useStoreApi();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  function commit() {
    const next = draft.trim();
    setEditing(false);
    if (next && next !== name) {
      api.getState().dispatch({ type: "rename_document", name: next }, "user");
    }
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        className="qa-document-name-input w-full rounded border border-gray-300 bg-white px-1.5 py-0.5 text-sm font-medium text-gray-800 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            setDraft(name);
            setEditing(false);
          }
        }}
      />
    );
  }

  return (
    <button
      type="button"
      className="qa-document-name -mx-1 rounded px-1 py-0.5 text-left text-sm font-medium text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800"
      title="Click to rename"
      onClick={() => {
        setDraft(name);
        setEditing(true);
      }}
    >
      {name}
    </button>
  );
}
