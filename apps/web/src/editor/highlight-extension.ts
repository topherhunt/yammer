import { StateEffect, StateField } from "@codemirror/state";
import type { Extension, Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin } from "@codemirror/view";
import type { ViewUpdate } from "@codemirror/view";
import { HIGHLIGHT_DURATION_MS, highlightOpacity } from "./highlights";

// CodeMirror wiring for the recency-fading edit highlights. A StateField holds
// the live highlight ranges (with birth timestamps); it maps them through
// document changes and drops expired ones. A view plugin ticks a few times a
// second so the opacity keeps fading while any highlight is alive. The fade
// curve itself lives in highlights.ts and is unit-tested there.

interface Highlight {
  from: number;
  to: number;
  at: number; // ms epoch when the edit landed
}

interface HighlightState {
  items: Highlight[];
  now: number;
}

/** Emitted by DocumentPanel right after applying an AI edit transaction. */
export const addHighlight = StateEffect.define<Highlight>();
/** Emitted by the ticking view plugin to advance the fade clock. */
export const tickHighlight = StateEffect.define<number>();
/** Emitted on document switch to clear all highlights at once. */
export const clearHighlights = StateEffect.define<void>();

const highlightField = StateField.define<HighlightState>({
  create: () => ({ items: [], now: Date.now() }),
  update(value, tr) {
    let now = value.now;
    let items = value.items.map((h) => ({
      ...h,
      from: tr.changes.mapPos(h.from),
      to: tr.changes.mapPos(h.to, 1),
    }));
    for (const effect of tr.effects) {
      if (effect.is(addHighlight)) items = [...items, effect.value];
      else if (effect.is(tickHighlight)) now = effect.value;
      else if (effect.is(clearHighlights)) items = [];
    }
    items = items.filter((h) => h.to > h.from && now - h.at < HIGHLIGHT_DURATION_MS);
    return { items, now };
  },
  provide: (field) =>
    EditorView.decorations.compute([field], (state) => {
      const { items, now } = state.field(field);
      const ranges: Range<Decoration>[] = items.map((h) =>
        Decoration.mark({
          class: "qa-edit-highlight",
          attributes: { style: `--hl-opacity:${highlightOpacity(now - h.at)}` },
        }).range(h.from, h.to),
      );
      return Decoration.set(ranges, true);
    }),
});

// Repaints the fade a few times a second, but only while highlights are alive
// so an idle editor does nothing.
const highlightTicker = ViewPlugin.fromClass(
  class {
    private timer: ReturnType<typeof setInterval> | null = null;
    constructor(private readonly view: EditorView) {
      this.sync();
    }
    update(_u: ViewUpdate) {
      this.sync();
    }
    private sync() {
      const alive = this.view.state.field(highlightField).items.length > 0;
      if (alive && this.timer === null) {
        this.timer = setInterval(() => {
          this.view.dispatch({ effects: tickHighlight.of(Date.now()) });
        }, 400);
      } else if (!alive && this.timer !== null) {
        clearInterval(this.timer);
        this.timer = null;
      }
    }
    destroy() {
      if (this.timer !== null) clearInterval(this.timer);
    }
  },
);

export function editHighlights(): Extension {
  return [highlightField, highlightTicker];
}

// Exposed for unit tests that assert the field's bookkeeping directly.
export function highlightItems(view: EditorView): { from: number; to: number }[] {
  return view.state.field(highlightField).items.map((h) => ({ from: h.from, to: h.to }));
}
