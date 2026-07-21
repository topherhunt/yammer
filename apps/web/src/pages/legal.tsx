// Standalone public pages served at /privacy-policy and /terms-of-service (see
// main.tsx). Plain-language and truthful to what the app actually does. Replace
// the contact line with a real address before going public.

import type { ReactNode } from "react";

function LegalShell(props: { title: string; children: ReactNode }) {
  return (
    <div className="mx-auto max-w-2xl px-6 py-12 text-slate-800 dark:text-slate-200">
      <a href="/" className="text-sm text-sky-600 hover:underline">
        &larr; Back to Yammer
      </a>
      <h1 className="mt-6 mb-2 text-3xl font-semibold">{props.title}</h1>
      <p className="mb-8 text-sm text-slate-500">Last updated: July 2026</p>
      <div className="space-y-5 leading-relaxed">{props.children}</div>
    </div>
  );
}

function H2(props: { children: ReactNode }) {
  return <h2 className="mt-8 text-xl font-semibold">{props.children}</h2>;
}

export function PrivacyPolicy() {
  return (
    <LegalShell title="Privacy Policy">
      <p>
        Yammer is a voice-driven writing assistant. This policy explains what we
        collect and why, in plain language.
      </p>

      <H2>What we collect</H2>
      <ul className="list-disc space-y-2 pl-6">
        <li>
          <strong>Account.</strong> When you sign in with Google we store your
          Google account identifier, email, and name to identify your account.
        </li>
        <li>
          <strong>Your writing.</strong> The documents you create and their full
          edit history are stored so you can access and restore them.
        </li>
        <li>
          <strong>Voice and commands.</strong> Your speech is transcribed to text
          to operate the app. We store the resulting transcripts, the app's
          responses, and usage/cost records (for the in-app spend meter and
          troubleshooting). We do not store raw audio on our servers.
        </li>
        <li>
          <strong>Cookies.</strong> A single secure, HTTP-only cookie keeps you
          signed in. No advertising or tracking cookies.
        </li>
      </ul>

      <H2>On-device processing</H2>
      <p>
        The wake word ("Yammer, wake up") is detected locally in your browser.
        That audio never leaves your device.
      </p>

      <H2>Third-party services we use</H2>
      <p>To provide the service, we send the data necessary to fulfill your requests to:</p>
      <ul className="list-disc space-y-2 pl-6">
        <li><strong>Google</strong> &mdash; sign-in.</li>
        <li><strong>OpenAI</strong> &mdash; speech-to-text transcription and interpreting your commands.</li>
        <li><strong>Tavily</strong> &mdash; web search, only when you explicitly ask Yammer to research something.</li>
      </ul>
      <p>We do not sell your data, show ads, or use third-party analytics or trackers.</p>

      <H2>Retention and control</H2>
      <p>
        Your documents and history remain until you delete them or your account.
        You can request deletion of your account and associated data at any time.
      </p>

      <H2>Changes</H2>
      <p>We will update this page if our practices change.</p>

      <H2>Contact</H2>
      <p>Questions? Contact the person who operates your Yammer instance.</p>
    </LegalShell>
  );
}

export function TermsOfService() {
  return (
    <LegalShell title="Terms of Service">
      <p>By using Yammer you agree to these terms.</p>

      <H2>The service</H2>
      <p>
        Yammer is a voice-driven writing and research assistant. It uses
        third-party AI services (including OpenAI) to transcribe speech and
        interpret your commands, and Tavily for web search when you ask.
      </p>

      <H2>Your content</H2>
      <p>
        Your documents are yours, and you are responsible for what you create
        with Yammer. You grant us only the permissions needed to operate the
        service: to store your content and to send the necessary parts to the
        third-party services above to carry out your requests.
      </p>

      <H2>Acceptable use</H2>
      <p>
        Use Yammer lawfully. Do not use it to create or distribute unlawful,
        harmful, or infringing content, or to disrupt or abuse the service.
      </p>

      <H2>AI limitations</H2>
      <p>
        AI output can be inaccurate. Review important results. Yammer is a tool to
        assist you, not a substitute for your own judgment.
      </p>

      <H2>Availability and "as is"</H2>
      <p>
        Yammer is provided "as is," without warranties, and we do not guarantee it
        will be uninterrupted or error-free.
      </p>

      <H2>Limitation of liability</H2>
      <p>
        To the extent permitted by law, we are not liable for indirect or
        consequential damages arising from your use of Yammer.
      </p>

      <H2>Changes</H2>
      <p>We may update these terms; continued use means you accept the changes.</p>

      <H2>Contact</H2>
      <p>Questions? Contact the person who operates your Yammer instance.</p>
    </LegalShell>
  );
}
