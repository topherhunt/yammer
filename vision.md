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

## Adjustments

- Auditory feedback beep / slot-click SFX when the listener detects you've stopped and sends your text to the LLM. And when you soft-mute, hard-mute, or unmute (listening activated, a brighter beep/xylophone sound).
- "**Wake phrase.** What word/phrase should resume-from-pause? (Porcupine works best with a distinct 2-3 syllable phrase; "Yammer" alone may false-trigger during dictation -- something like "Hey Yammer" or "Okay Yammer" is safer.) Also: Porcupine's free tier is fine for personal use, but confirm you're OK adding Picovoice as a dependency (there are open-alternatives if not)." => Let's do "Yammer, wake up".
- "**Stop-intent false positives.** How aggressive should the "stop listening" inference be? Too eager and normal dictation containing "stop" pauses him mid-sentence; too cautious and he can't stop when a visitor arrives. I lean cautious + instant wake-word recovery. Any preference on erring one way?" => The user should need to say something pretty explicit like "stop recording" or "stop listening", or "Yammer, pause the mic" or "Hold on, I'm talking to my wife". Something That clearly conveys his intention that you shouldn't pay attention to what he's saying. Simply saying the word stop is not enough. 
- "**Research provider key.** Tavily (default) vs Exa -- do you have/prefer either? Both free at your volume; I'll wire Tavily unless you say otherwise." => Initially I was leaning towards EXA because I was like, why would you go with Tavali if Tavali only gives you 1,000 requests per month free and EXA gives you 20,000 per month free? But on second thought, I don't think we will do 1,000 or 20,000. And so we might as well just pick the one that you recommended. 
- "**STT streaming vs cheaper batch.** Default to `gpt-realtime-whisper` streaming ($0.017/min) for snappy UX, or start with `gpt-4o-transcribe` batch ($0.006/min, \~3x cheaper) and accept slightly higher latency? I lean streaming; with VAD-gating we only pay for real speech." => No, we definitely want the real-time whisper endpoint because we do want to optimize for latency. That is a price point where I'm not at all worried. And frankly, now that I understand more about how the GPT real-time 2.1 endpoints are built, now that I understand that a million tokens actually counts as a lot of minutes of input, even that would be fine. But obviously we don't need the voice audio output, so that's not the endpoint that we need. So let's go with the GPT real-time whisper, please. 
- "**Mic while backgrounded / multi-tab.** Acceptable that listening pauses when the tab isn't foregrounded (and multi-device means only the active tab listens)? I assume yes." => Yes, correct. So if the tab is backgrounded or if the user switches to a different tab, the JavaScript should stop the mic from listening. And then when the tab is foregrounded again, it should resume listening, as long as Chrome and other browsers will support that and not treat that as, oh my god, this is sneaky behavior that's contravening user intent. 
