// A short, friendly AI intro shown at the top of a fresh session, assembled from
// interchangeable fragments so it varies without needing an LLM call. Greeting +
// invitation + one rotating tip -- just enough to say "we're here, start talking."

const GREETINGS = [
  "Hi there!",
  "Hey, good to see you.",
  "Welcome back.",
  "Hello!",
  "Ready when you are.",
];

const INVITATIONS = [
  "What would you like to work on?",
  "Where should we start today?",
  "What are we writing?",
  "What's on your mind?",
  "How do you want to begin?",
];

const TIPS = [
  "Just start talking -- I'll turn your words into text and edits.",
  'Say "Yammer, wake up" to resume after you pause the mic.',
  "You can also type in the box below if you'd rather.",
  "Ask me to research something and I'll dig it up for you.",
  'Speak naturally -- e.g. "start a new document about the garden."',
  "Tell me to reword, shorten, or fix anything, anytime.",
];

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)]!;
}

/** A randomly-composed greeting: "<greeting> <invitation>\n\n<tip>". */
export function randomGreeting(): string {
  return `${pick(GREETINGS)} ${pick(INVITATIONS)}\n\n${pick(TIPS)}`;
}
