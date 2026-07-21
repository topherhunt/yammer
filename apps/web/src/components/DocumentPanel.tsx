import { useEffect, useRef } from "react";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { Annotation, EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { computeChange } from "../editor/changes";
import { addHighlight, clearHighlights, editHighlights } from "../editor/highlight-extension";
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
  const scrollCommand = useAppStore((s) => s.scrollCommand);

  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const lastDocIdRef = useRef<string | null>(null);

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
          EditorView.updateListener.of((u) => {
            if (
              u.docChanged &&
              !u.transactions.some((t) => t.annotation(External))
            ) {
              api.getState().setDocumentText(u.state.doc.toString());
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
      <div className="qa-document-name border-b border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 dark:border-gray-800 dark:text-gray-200">
        {doc ? doc.name : "No document"}
      </div>
      <div
        ref={hostRef}
        // The editable document region. CodeMirror renders its own textbox
        // inside; labelling the region names it for assistive tech.
        role="region"
        aria-label={doc ? `Document: ${doc.name}` : "Document editor"}
        className="qa-document-editor flex-1 overflow-auto"
      />
    </div>
  );
}
