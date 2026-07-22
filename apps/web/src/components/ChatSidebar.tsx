import { useEffect, useRef } from "react";
import type { ChatEntry } from "@yammer/shared";
import { cx } from "../util/cx";
import { useAppStore } from "../store/context";
import { ChatComposer } from "./ChatComposer";
import { SpendMeter } from "./SpendMeter";

// The chat sidebar: a scrolling message list (dictated text, AI messages,
// attributed edits/restores, thinking statuses, research notes, errors), the
// listening indicator, and the spend meter pinned at the bottom.

// The rendered content of one entry (the styled bubble / status line). It is NOT
// the <li> -- ChatSidebar wraps each of these in an animating grid <li> that grows
// it from height 0 to its natural height. Right-alignment for the user's own
// messages lives on that wrapper (see entryAlignEnd); everything else is left/full.
function ChatMessageView({ entry }: { entry: ChatEntry }) {
  switch (entry.kind) {
    case "user_message":
      return (
        <div className="qa-chat-entry qa-chat-user rounded-lg bg-blue-500 px-3 py-2 text-sm text-white">
          {entry.text}
        </div>
      );
    case "ai_message":
      return (
        <div className="qa-chat-entry qa-chat-ai rounded-lg bg-gray-100 px-3 py-2 text-sm text-gray-800 dark:bg-gray-800 dark:text-gray-100">
          {entry.text}
        </div>
      );
    case "thinking":
      return (
        <div className="qa-chat-entry qa-chat-thinking text-xs italic text-gray-500 dark:text-gray-400">
          {entry.status}
        </div>
      );
    case "edit":
      return (
        <div
          className="qa-chat-entry qa-chat-edit text-xs text-gray-600 dark:text-gray-300"
          data-author={entry.author}
        >
          <span className="qa-chat-author font-medium">
            {entry.author === "ai" ? "AI" : "You"}
          </span>{" "}
          edited: {entry.summary}
        </div>
      );
    case "restore":
      return (
        <div
          className="qa-chat-entry qa-chat-restore text-xs text-gray-600 dark:text-gray-300"
          data-author={entry.author}
        >
          <span className="qa-chat-author font-medium">
            {entry.author === "ai" ? "AI" : "You"}
          </span>{" "}
          restored: {entry.summary}
        </div>
      );
    case "research":
      return (
        <div className="qa-chat-entry qa-chat-research rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 dark:border-gray-700 dark:text-gray-200">
          <span className="font-medium">Research: </span>
          {entry.summary}
        </div>
      );
    case "document":
      // A centered divider marking a document boundary in the session transcript.
      return (
        <div
          className="qa-chat-entry qa-chat-document my-1 flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400"
          data-event={entry.event}
        >
          <span className="h-px flex-1 bg-gray-200 dark:bg-gray-700" />
          <span className="whitespace-nowrap">
            {entry.event === "created" ? "Created" : "Opened"}{" "}
            <span className="font-medium">{entry.name}</span>
          </span>
          <span className="h-px flex-1 bg-gray-200 dark:bg-gray-700" />
        </div>
      );
    case "error":
      return (
        // role=status + assertive aria-live so failures (STT/mic/reconnect/save)
        // are announced to assistive tech, not just shown -- high priority for an
        // AT-dependent user who is watching the document, not the sidebar.
        <div
          role="status"
          aria-live="assertive"
          className="qa-chat-entry qa-chat-error rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300"
        >
          {entry.message}
        </div>
      );
  }
}

/** Alignment + width cap for one entry's wrapper (the animating <li> flex item, NOT
 * the bubble -- putting the % width on a shrink-wrapped grid item made it erratic).
 * The user's dictated messages hug the right at up to 85% width; AI replies hug the
 * left at up to 85%; status/edit/error lines span the full width. */
function entryWrapperClass(entry: ChatEntry): string {
  switch (entry.kind) {
    case "user_message":
      return "self-end max-w-[85%]";
    case "ai_message":
      return "self-start max-w-[85%]";
    default:
      return "self-stretch";
  }
}

export function ChatSidebar() {
  const chat = useAppStore((s) => s.app.chat);
  // The message the model is currently working on (last in the in-flight batch).
  // Messages after it are queued -- spoken while the turn ran, not yet seen.
  const workingAnchorId = useAppStore((s) => s.workingAnchorId);
  // The research pipeline outlives the turn that launched it; keep a spinner on the
  // latest entry while it runs so the user knows work is still in flight.
  const researching = useAppStore((s) => s.researching);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    // Only auto-follow when the user is already near the bottom -- never yank them
    // away from earlier messages they scrolled up to read.
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (!nearBottom) return;
    if (typeof requestAnimationFrame !== "function") {
      el.scrollTop = el.scrollHeight;
      return;
    }
    // A new entry grows from height 0 to full over ~300ms, so one scroll at insert
    // time lands short. Keep pinning to the bottom for the animation's duration so
    // the whole message ends up visible.
    const start = performance.now();
    let raf = requestAnimationFrame(function pin() {
      el.scrollTop = el.scrollHeight;
      if (performance.now() - start < 360) raf = requestAnimationFrame(pin);
    });
    return () => cancelAnimationFrame(raf);
  }, [chat.length]);

  return (
    <div className="flex h-full flex-col">
      <ul
        ref={listRef}
        // role="log" marks this as the running conversation transcript, so AT
        // treats it as a live region (new dictation/AI/edit entries are announced)
        // without competing with the assertive per-error aria-live entries.
        role="log"
        aria-label="Conversation"
        aria-live="polite"
        className={cx("qa-chat-list flex flex-1 flex-col gap-2 overflow-y-auto p-3")}
      >
        {chat.length === 0 ? (
          <li className="qa-chat-empty text-sm text-gray-400 dark:text-gray-500">
            Say something to start writing.
          </li>
        ) : (
          chat.map((entry, i) => {
            const alignEnd = entry.kind === "user_message";
            // Spinner while the model works this message, OR while research (which
            // outlives the turn) runs -- pinned to the latest entry in that case.
            const working =
              entry.id === workingAnchorId ||
              (researching && i === chat.length - 1);
            return (
              <li
                key={entry.id}
                // Each new entry grows from height 0 to its natural height over 300ms
                // (grid-rows 0fr->1fr; see .qa-chat-anim). Alignment lives here on the
                // flex item; the bubble styling lives on the inner content.
                className={cx("qa-chat-anim", entryWrapperClass(entry))}
              >
                <div className="qa-chat-anim-inner">
                  {working ? (
                    <div
                      className={cx(
                        "flex items-end gap-1.5",
                        alignEnd ? "justify-end" : "justify-start",
                      )}
                    >
                      <span
                        role="status"
                        aria-label="The AI is working"
                        className="qa-working-spinner mb-1 h-3.5 w-3.5 shrink-0"
                      />
                      <div className="min-w-0">
                        <ChatMessageView entry={entry} />
                      </div>
                    </div>
                  ) : (
                    <ChatMessageView entry={entry} />
                  )}
                </div>
              </li>
            );
          })
        )}
      </ul>
      <ChatComposer />
      <SpendMeter />
    </div>
  );
}
