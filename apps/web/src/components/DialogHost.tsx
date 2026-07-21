import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import type { Action, SortKey, Theme } from "@yammer/shared";
import { cx } from "../util/cx";
import { useAppStore, useStoreApi } from "../store/context";

// Modal host for the four dialogs (menu / help / load / history). Fully
// mouse+keyboard operable: Escape and backdrop-click close, every option is a
// native button. Each option maps to exactly one Action dispatched through the
// reducer -- the same actions the LLM would emit by voice.

const MENU_ITEMS: { label: string; action: Action; qa: string }[] = [
  { label: "New document", action: { type: "new_document" }, qa: "qa-menu-new" },
  { label: "Load document", action: { type: "open_dialog", dialog: "load" }, qa: "qa-menu-load" },
  { label: "Edit history", action: { type: "open_dialog", dialog: "history" }, qa: "qa-menu-history" },
  { label: "Copy document", action: { type: "copy_document" }, qa: "qa-menu-copy" },
  { label: "Download .md", action: { type: "download_document", format: "md" }, qa: "qa-menu-download-md" },
  { label: "Download .docx", action: { type: "download_document", format: "docx" }, qa: "qa-menu-download-docx" },
  { label: "Download diagnostic log", action: { type: "download_diagnostics" }, qa: "qa-menu-diagnostics" },
  { label: "Settings", action: { type: "open_dialog", dialog: "settings" }, qa: "qa-menu-settings" },
  { label: "Help", action: { type: "open_dialog", dialog: "help" }, qa: "qa-menu-help" },
];

const THEMES: { key: Theme; label: string }[] = [
  { key: "system", label: "System" },
  { key: "light", label: "Light" },
  { key: "dark", label: "Dark" },
];

const SORTS: { key: SortKey; label: string }[] = [
  { key: "updated", label: "Updated" },
  { key: "created", label: "Created" },
  { key: "name", label: "Name" },
];

const FOCUSABLE =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

function DialogFrame({
  title,
  qa,
  onClose,
  children,
}: {
  title: string;
  qa: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  // Accessibility: on open, remember the trigger and move focus into the dialog;
  // trap Tab within it so keyboard/AT users cannot tab out to the (inert) page
  // behind the modal; on close (unmount), restore focus to the trigger. Escape
  // is handled at the DialogHost level. A `key` on each DialogFrame remounts this
  // effect when the user switches dialogs, so focus moves in for the new one.
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const trigger = document.activeElement as HTMLElement | null;

    const focusables = (): HTMLElement[] =>
      Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => !el.hasAttribute("disabled"),
      );

    // Move focus to the first control (fall back to the panel itself).
    (focusables()[0] ?? panel).focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === panel)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    panel.addEventListener("keydown", onKey);
    return () => {
      panel.removeEventListener("keydown", onKey);
      // Restore focus to whatever opened the dialog, if it is still in the DOM.
      if (trigger && document.contains(trigger)) trigger.focus();
    };
  }, []);

  return (
    <div
      className="qa-dialog-backdrop fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={cx(
          qa,
          "qa-dialog w-full max-w-md rounded-xl bg-white p-4 shadow-xl outline-none dark:bg-gray-900",
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold text-gray-800 dark:text-gray-100">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close dialog"
            className="qa-dialog-close btn-3d bg-gray-100 px-2 py-1 text-gray-600 dark:bg-gray-800 dark:text-gray-300"
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

const itemClass =
  "btn-3d w-full bg-gray-50 px-3 py-2 text-left text-sm text-gray-700 dark:bg-gray-800 dark:text-gray-200";

export function DialogHost() {
  const api = useStoreApi();
  const openDialog = useAppStore((s) => s.app.openDialog);
  const documents = useAppStore((s) => s.app.documents);
  const history = useAppStore((s) => s.app.history);
  const loadSort = useAppStore((s) => s.app.settings.loadDocSort);
  const settings = useAppStore((s) => s.app.settings);

  const close = () => api.getState().dispatch({ type: "close_dialog" });

  useEffect(() => {
    if (!openDialog) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openDialog]);

  if (!openDialog) return null;
  const dispatch = (action: Action) => api.getState().dispatch(action);

  if (openDialog === "menu") {
    return (
      <DialogFrame key="menu" title="Menu" qa="qa-dialog-menu" onClose={close}>
        <div className="flex flex-col gap-1">
          {MENU_ITEMS.map((item) => (
            <button
              key={item.qa}
              type="button"
              className={cx(item.qa, itemClass)}
              onClick={() => dispatch(item.action)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </DialogFrame>
    );
  }

  if (openDialog === "help") {
    return (
      <DialogFrame key="help" title="Help" qa="qa-dialog-help" onClose={close}>
        <div className="qa-help-body space-y-2 text-sm text-gray-600 dark:text-gray-300">
          <p>Speak naturally to write, edit, navigate, or research. What you say is interpreted as a command -- dictation is just one kind.</p>
          <p>Say an explicit phrase like "stop listening" to pause; say "Yammer, wake up" to resume. Every control here also works with mouse and keyboard.</p>
        </div>
      </DialogFrame>
    );
  }

  if (openDialog === "settings") {
    const updateSettings = (patch: Partial<typeof settings>) =>
      api.getState().updateSettings(patch);
    return (
      <DialogFrame key="settings" title="Settings" qa="qa-dialog-settings" onClose={close}>
        <div className="qa-settings-body flex flex-col gap-4 text-sm">
          <fieldset className="qa-settings-theme flex flex-col gap-2">
            <legend className="font-medium text-gray-700 dark:text-gray-200">Theme</legend>
            <div className="flex gap-1">
              {THEMES.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => updateSettings({ theme: t.key })}
                  data-active={settings.theme === t.key}
                  aria-pressed={settings.theme === t.key}
                  className={cx(
                    `qa-settings-theme-${t.key} btn-3d px-3 py-1.5 text-sm`,
                    settings.theme === t.key
                      ? "bg-blue-500 text-white"
                      : "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300",
                  )}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </fieldset>

          <label className="qa-settings-sfx flex items-center justify-between gap-3">
            <span className="font-medium text-gray-700 dark:text-gray-200">Sound effects</span>
            <input
              type="checkbox"
              className="qa-settings-sfx-input h-4 w-4"
              checked={settings.sfxEnabled}
              onChange={(e) => updateSettings({ sfxEnabled: e.target.checked })}
            />
          </label>

          <label className="qa-settings-silence flex items-center justify-between gap-3">
            <span className="text-gray-700 dark:text-gray-200">Silence threshold (ms)</span>
            <input
              type="number"
              min={0}
              step={50}
              className="qa-settings-silence-input w-24 rounded border border-gray-300 bg-white px-2 py-1 text-right dark:border-gray-700 dark:bg-gray-800"
              value={settings.silenceThresholdMs}
              onChange={(e) => updateSettings({ silenceThresholdMs: e.target.valueAsNumber })}
            />
          </label>

          <label className="qa-settings-optimistic flex items-center justify-between gap-3">
            <span className="text-gray-700 dark:text-gray-200">Optimistic-send delay (ms)</span>
            <input
              type="number"
              min={0}
              step={50}
              className="qa-settings-optimistic-input w-24 rounded border border-gray-300 bg-white px-2 py-1 text-right dark:border-gray-700 dark:bg-gray-800"
              value={settings.optimisticSendMs}
              onChange={(e) => updateSettings({ optimisticSendMs: e.target.valueAsNumber })}
            />
          </label>

          <label className="qa-settings-compact flex items-center justify-between gap-3">
            <span className="text-gray-700 dark:text-gray-200">Chat compaction threshold</span>
            <input
              type="number"
              min={1}
              step={1}
              className="qa-settings-compact-input w-24 rounded border border-gray-300 bg-white px-2 py-1 text-right dark:border-gray-700 dark:bg-gray-800"
              value={settings.chatCompactThreshold}
              onChange={(e) => updateSettings({ chatCompactThreshold: e.target.valueAsNumber })}
            />
          </label>
        </div>
      </DialogFrame>
    );
  }

  if (openDialog === "load") {
    return (
      <DialogFrame key="load" title="Load document" qa="qa-dialog-load" onClose={close}>
        <div className="qa-load-sorts mb-3 flex gap-1">
          {SORTS.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => dispatch({ type: "open_dialog", dialog: "load", sort: s.key })}
              className={cx(
                "qa-load-sort btn-3d px-2.5 py-1 text-xs",
                loadSort === s.key
                  ? "bg-blue-500 text-white"
                  : "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300",
              )}
              data-active={loadSort === s.key}
            >
              {s.label}
            </button>
          ))}
        </div>
        <ul className="qa-load-list flex max-h-72 flex-col gap-1 overflow-y-auto">
          {documents.length === 0 ? (
            <li className="qa-load-empty px-3 py-2 text-sm text-gray-400">No documents yet.</li>
          ) : (
            documents.map((d) => (
              <li key={d.id}>
                <button
                  type="button"
                  className={cx("qa-load-item", itemClass)}
                  data-doc-id={d.id}
                  onClick={() => dispatch({ type: "load_document", documentId: d.id })}
                >
                  <span className="qa-load-item-name font-medium">{d.name}</span>
                  <span className="ml-2 text-xs text-gray-400">updated {d.updatedAt.slice(0, 10)}</span>
                </button>
              </li>
            ))
          )}
        </ul>
      </DialogFrame>
    );
  }

  // history
  const newestFirst = [...history].reverse();
  return (
    <DialogFrame key="history" title="Edit history" qa="qa-dialog-history" onClose={close}>
      <ul className="qa-history-list flex max-h-72 flex-col gap-1 overflow-y-auto">
        {newestFirst.length === 0 ? (
          <li className="qa-history-empty px-3 py-2 text-sm text-gray-400">No history yet.</li>
        ) : (
          newestFirst.map((v) => (
            <li
              key={v.id}
              className="qa-history-item flex items-center justify-between gap-2 rounded px-3 py-2 text-sm"
              data-version-id={v.id}
            >
              <span className="min-w-0">
                <span className="qa-history-summary text-gray-700 dark:text-gray-200">{v.summary}</span>
                <span className="ml-2 text-xs text-gray-400">
                  v{v.seq} · {v.author} · {v.kind}
                </span>
              </span>
              <button
                type="button"
                className="qa-history-restore btn-3d shrink-0 bg-gray-100 px-2.5 py-1 text-xs text-gray-700 dark:bg-gray-800 dark:text-gray-200"
                onClick={() => dispatch({ type: "restore_version", seq: v.seq })}
              >
                Restore
              </button>
            </li>
          ))
        )}
      </ul>
    </DialogFrame>
  );
}
