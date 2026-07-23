// The no-document welcome panel's text, assembled from interchangeable fragments so
// the framing varies a little each time (like the chat greeting), without an LLM.

const OPENERS = [
  "Welcome to Yammer.",
  "Hi there -- welcome to Yammer.",
  "Yammer's ready when you are.",
  "Hey! This is Yammer.",
  "Welcome aboard.",
];

const STATE = [
  "No document is open yet.",
  "Nothing's open right now.",
  "There's no document open at the moment.",
];

const INVITES = [
  'Say "open a document" to load one, "new document" to start fresh, or just start talking to your AI sidekick and see where things go.',
  'Ask to load a document, create a new one, or simply start chatting with your AI sidekick and see what unfolds.',
  'You can open an existing document, start a new one, or just begin talking -- your AI sidekick will follow along.',
  'Load something you\'ve written, start a blank page, or riff out loud with your AI sidekick and see where it takes you.',
];

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)]!;
}

/** A randomly-composed welcome for the empty-document state. */
export function randomWelcome(): { title: string; body: string } {
  return { title: pick(OPENERS), body: `${pick(STATE)} ${pick(INVITES)}` };
}
