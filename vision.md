VISION: A 100% voice-driven, 100% AI-driven text editor that requires zero mouse or keyboard input. Text editing at the speed of speech.

CONTEXT: For a friend of mine who has lost most muscle function due to ALS and wants lower-friction ways to write, AI-chat, and research.

---

Requirements:

- Architecture: TypeScript, probably React or SolidJS frontend, Express or (what's the hot popular newer one? Hono?) backend.
- The UI shows 2 panels (if on desktop, or toggle-back-and-forth on mobile), the AI chat sidebar on the left and the main document on the right. 
- Continuous microphone listening captures what you say, STT's your words into text, and sends that to Claude as a command (along with our system instructions documenting the available tool calls, how input text should be interpreted, editing instructions eg maximally preserve the speaker's voice and wording UNLESS they explicitly ask you to reword, and situational context like what document is currently loaded, the current full text of the document, a summary of the edit history, what dialog is currently open if any and what's shown in it (documents available to load, or the full edit history of this document, or the menu buttons, or whatever), (important!!) scroll status and what content is currently visible on the user's screen). Claude returns structured json of the tool calls it wants to make, eg a text edit, scrolling 1 page down in the document, showing the Help menu, and returning a short message in the chat sidebar (chat message is optional, the AI should be judicious about it and not add frivolous chat messages when just showing a menu or scrolling or making an uncontroversial little edit).
- All edits (and version-restores) are shown in the chat sidebar, attributed either to you or to the AI depending on who did that edit.
- Some tool calls are just UI navigation like "show menu", "scroll down" etc. (The user can also use the mouse & keyboard to navigate all UI elements like normal web app usage -- click the cursor, open the main menu, load a document, edit or delete or cut & paste text, etc. But neither of those are ever REQUIRED to efficiently and fluidly do all things in the app.
- The user can create many documents, and then Load Document lists them all with their name, creation date, last updated date, and pick one to open.
- All edits to each document are preserved in an edit history list, so at any time you can ask claude to show your edit history and restore to any particular version. We need to be very careful about choosing a battle-tested edit-tracking system so only the edits need to be preserved (saving space) but they can be effortlessly replayed with no risk of corrupting or losing changes. And the user can say "show edit history" and see a list of all recent edits, and ask the AI to restore the document to a particular snapshot (which is reconstituted and then subbed in as a NEW version/edit, tagged as a snapshot-restore in the edit history list, but similar to Git it always only appends to edit history rather than altering it). The user can also say "Restore the 3rd paragraph to what it was a few edits ago", and the AI is accountable for 
- When a message has been sent to the AI, it appears in the chat sidebar and then the AI's thinking status / thought process is shown below it with a spinner to indicate that it's percolating. eg "Converting to text...", "Thinking...", "Searching the web", etc.
- This app needs detailed comprehensive test coverage, both end-to-end and unit tests. Design the code and test suite to optimize for "as much as possible can be covered by unit tests".
- The text model needs to be swappable. Please help me research on a cheap but high-performing model I can use in dev & test -- maybe deepseek/deepseek-v4-flash which is $0.09/Mtok, or moonshotai/kimi-k2.5, or whatever you think gets me the most bang for buck. Production will be a choice between Sonnet 5 and gpt-5.6-luna. Maybe use gpt-5.6-luna in dev too -- how does it compare in benchmarks against Kimi & Deepseek & others? We're looking for models that are rated as great for writing & research, and can reliably do structured tool calls. Maybe working with fewer models is better, for simplicity. Research on gpt 5.6 luna vs terra, and 5.6 luna vs claude-4.5-haiku.
- See the STT question above -- should I look into a combined text-and-audio model that can take in audio streamed directly and return text? I think no, I think the pluggability of different (cheaper and more powerful) text models and STT models is more important than optimizing for raw response time, but I'd like your input.

---

Tools available to it:

- show menu
- show help (pop-up lists basic usage & all available commands/keywords)
- close window (menu/help/load dialog)
- (if in mobile) show chat / show document
- new document
- list documents (opens up a list panel)
- load document
  - (if on the Load Document page) sort by (name / creation date / last updated) - your sort setting persists as part of the app settings state
  - specify the name and/or creation/update date of a document to open that document
- rename document
- show edit history
- restore an older version
- read an older version into context so it can manually patch in a specific part of it
- scroll up / down
- scroll chat up / down
- scroll up / down (shorthand for scroll document up/down if you're viewing a document; if you're in a dialog, it scrolls in that instead)
- edit text fragment
- search the web / research
  - (a multi-step tool call that is only ever invoked when the user asks for research, the AI should never do so unprompted; run a web search for one or more terms, then get the fulltext of one or more result urls, read those and gen a summary of findings from them, to be included into the AI's chat context.) Web searches require a call to my backend api and must be run from that backend due to browser fetch domain restrictions.)

---

Open questions:

- Name: Something short and playful, almost teasing, like chatty or chatter or blabber. "Yadda" came to mind but does that really evoke a chatty talky person?
- STT: Is it easy to do stt in the browser locally using a downloaded model like Parakeet? Or is it better to use an OpenAI STT API endpoint or some such? Streaming is preferable whether local or remote.
- How should the listener logic decide when the speaker is done and it should trigger STT? Naively, at the very least, listen for a pause and then trigger it. We also need a **visual indicator** (at bottom of the chat sidebar) that the listener is listening vs sending. It should pulse when it hears audio input (showing that it's capturing it); when it gets silence, show a radial progress bar indicating that it's (a) doing STT and (b) about to send to Claude if it doesn't hear back from you. ("Optimistic STT" makes for snappier responses but means it's that much more important to have local STT conversion so you don't burn tokens converting text you'll throw away because you weren't finished speaking.)
- How to deal with context limits? - Periodically compact old chat history into a summary block, so Claude knows the key context from the chat history but doesn't need every tiny detail of every edit it's made. I think that should be enough; even a 50-page document isn't *that* much context, only \~30k tokens.
