import { useEffect, useRef } from "react";
import type { ChatEntry } from "@yammer/shared";
import { cx } from "../util/cx";
import { useAppStore } from "../store/context";
import { ListeningIndicator } from "./ListeningIndicator";
import { SpendMeter } from "./SpendMeter";

// The chat sidebar: a scrolling message list (dictated text, AI messages,
// attributed edits/restores, thinking statuses, research notes, errors), the
// listening indicator, and the spend meter pinned at the bottom.

function ChatMessageView({ entry }: { entry: ChatEntry }) {
  switch (entry.kind) {
    case "user_message":
      return (
        <li className="qa-chat-entry qa-chat-user self-end max-w-[85%] rounded-lg bg-blue-500 px-3 py-2 text-sm text-white">
          {entry.text}
        </li>
      );
    case "ai_message":
      return (
        <li className="qa-chat-entry qa-chat-ai max-w-[85%] rounded-lg bg-gray-100 px-3 py-2 text-sm text-gray-800 dark:bg-gray-800 dark:text-gray-100">
          {entry.text}
        </li>
      );
    case "thinking":
      return (
        <li className="qa-chat-entry qa-chat-thinking text-xs italic text-gray-500 dark:text-gray-400">
          {entry.status}
        </li>
      );
    case "edit":
      return (
        <li
          className="qa-chat-entry qa-chat-edit text-xs text-gray-600 dark:text-gray-300"
          data-author={entry.author}
        >
          <span className="qa-chat-author font-medium">
            {entry.author === "ai" ? "AI" : "You"}
          </span>{" "}
          edited: {entry.summary}
        </li>
      );
    case "restore":
      return (
        <li
          className="qa-chat-entry qa-chat-restore text-xs text-gray-600 dark:text-gray-300"
          data-author={entry.author}
        >
          <span className="qa-chat-author font-medium">
            {entry.author === "ai" ? "AI" : "You"}
          </span>{" "}
          restored: {entry.summary}
        </li>
      );
    case "research":
      return (
        <li className="qa-chat-entry qa-chat-research rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 dark:border-gray-700 dark:text-gray-200">
          <span className="font-medium">Research: </span>
          {entry.summary}
        </li>
      );
    case "error":
      return (
        // role=status + assertive aria-live so failures (STT/mic/reconnect/save)
        // are announced to assistive tech, not just shown -- high priority for an
        // AT-dependent user who is watching the document, not the sidebar.
        <li
          role="status"
          aria-live="assertive"
          className="qa-chat-entry qa-chat-error rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300"
        >
          {entry.message}
        </li>
      );
  }
}

export function ChatSidebar() {
  const chat = useAppStore((s) => s.app.chat);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
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
          chat.map((entry) => <ChatMessageView key={entry.id} entry={entry} />)
        )}
      </ul>
      <ListeningIndicator />
      <SpendMeter />
    </div>
  );
}
