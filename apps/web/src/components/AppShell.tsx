import { cx } from "../util/cx";
import { useAppStore, useStoreApi } from "../store/context";
import { useTheme } from "../theme/useTheme";
import { ChatSidebar } from "./ChatSidebar";
import { DocumentPanel } from "./DocumentPanel";
import { DialogHost } from "./DialogHost";
import { TapToStartGate } from "./TapToStartGate";

// Two-panel shell: chat sidebar (left) + document (right) on desktop; a single
// panel with a voice/tap toggle on mobile (iOS-first). Theme follows the OS by
// default. The dialog host overlays the whole shell.

export function AppShell() {
  const api = useStoreApi();
  const theme = useAppStore((s) => s.app.settings.theme);
  const activePanel = useAppStore((s) => s.app.activePanel);
  useTheme(theme);

  const showChat = activePanel === "chat";

  return (
    <div className="qa-app-shell flex h-screen flex-col bg-white text-gray-900 dark:bg-gray-950 dark:text-gray-100">
      <header className="qa-app-header flex items-center justify-between border-b border-gray-200 px-4 py-2 dark:border-gray-800">
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-label="Open menu"
            className="qa-menu-button btn-3d bg-gray-100 px-2 py-1.5 text-gray-700 dark:bg-gray-800 dark:text-gray-200"
            onClick={() => api.getState().dispatch({ type: "open_dialog", dialog: "menu" })}
          >
            ☰
          </button>
          <span className="font-semibold">Yammer</span>
        </div>
        {/* Mobile-only panel toggle. */}
        <div className="qa-panel-toggle flex gap-1 md:hidden">
          <button
            type="button"
            aria-pressed={showChat}
            className={cx(
              "qa-panel-toggle-chat btn-3d px-2.5 py-1 text-xs",
              showChat ? "bg-blue-500 text-white" : "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300",
            )}
            onClick={() => api.getState().dispatch({ type: "set_panel", panel: "chat" })}
          >
            Chat
          </button>
          <button
            type="button"
            aria-pressed={!showChat}
            className={cx(
              "qa-panel-toggle-document btn-3d px-2.5 py-1 text-xs",
              !showChat ? "bg-blue-500 text-white" : "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300",
            )}
            onClick={() => api.getState().dispatch({ type: "set_panel", panel: "document" })}
          >
            Document
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside
          className={cx(
            "qa-chat-sidebar w-full shrink-0 border-r border-gray-200 dark:border-gray-800 md:flex md:w-1/3",
            showChat ? "flex" : "hidden",
          )}
        >
          <div className="h-full w-full">
            <ChatSidebar />
          </div>
        </aside>
        <main
          className={cx(
            "qa-document-panel min-w-0 flex-1 md:flex",
            showChat ? "hidden" : "flex",
          )}
        >
          <div className="h-full w-full">
            <DocumentPanel />
          </div>
        </main>
      </div>

      <DialogHost />
      <TapToStartGate />
    </div>
  );
}
