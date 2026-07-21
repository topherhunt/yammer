import { useEffect, useState, type ReactNode } from "react";

// Auth gate for the real app: the server requires a signed-in session for every
// /api call and the /api/stt WebSocket, so we check /api/me on load and show a
// "Sign in with Google" screen until the user is authenticated. The backend-less
// mock demo (VITE_MOCK) and injected-store tests skip this entirely.

type AuthState = "loading" | "authed" | "anon";

function FullScreen({ children }: { children: ReactNode }) {
  return (
    <div className="grid h-screen place-items-center bg-white p-6 text-gray-900 dark:bg-gray-950 dark:text-gray-100">
      {children}
    </div>
  );
}

export function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>("loading");

  useEffect(() => {
    if (import.meta.env.VITE_MOCK === "1") {
      setState("authed");
      return;
    }
    let alive = true;
    fetch("/api/me", { credentials: "include" })
      .then((r) => {
        if (alive) setState(r.ok ? "authed" : "anon");
      })
      .catch(() => {
        if (alive) setState("anon");
      });
    return () => {
      alive = false;
    };
  }, []);

  if (state === "loading") {
    return (
      <FullScreen>
        <p className="text-sm text-gray-500" role="status">
          Loading Yammer…
        </p>
      </FullScreen>
    );
  }

  if (state === "anon") {
    return (
      <FullScreen>
        <div className="qa-signin-screen flex flex-col items-center gap-6 text-center">
          <h1 className="text-3xl font-semibold">Yammer</h1>
          <p className="max-w-xs text-sm text-gray-500 dark:text-gray-400">
            Write, edit, and research with your voice. Sign in to continue.
          </p>
          <a
            href="/auth/google"
            className="qa-signin btn-3d bg-blue-500 px-6 py-3 text-base font-medium text-white"
          >
            Sign in with Google
          </a>
        </div>
      </FullScreen>
    );
  }

  return <>{children}</>;
}
