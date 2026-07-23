import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";

// The persistent insertion cursor: a blue, gently-blinking vertical line drawn at
// the store's `cursor` offset, so the user always sees where dictated content will
// land -- even when the editor isn't focused (CodeMirror's own caret hides then).
// It's a widget decoration driven by the setCursorPos effect from DocumentPanel.

class CursorWidget extends WidgetType {
  override eq(): boolean {
    return true; // all instances render the same line
  }
  override toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "qa-doc-cursor";
    el.setAttribute("aria-hidden", "true");
    return el;
  }
  override ignoreEvent(): boolean {
    return true;
  }
}

/** Set the cursor to a document offset. */
export const setCursorPos = StateEffect.define<number>();

const cursorMark = Decoration.widget({ widget: new CursorWidget(), side: -1 });

export const cursorField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setCursorPos)) {
        // A negative offset means "no cursor" (e.g. no document open) -- clear it.
        if (e.value < 0) {
          deco = Decoration.none;
        } else {
          const pos = Math.min(e.value, tr.state.doc.length);
          deco = Decoration.set([cursorMark.range(pos)]);
        }
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});
