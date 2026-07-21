import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { PrivacyPolicy, TermsOfService } from "./pages/legal";
import "./index.css";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("Root element #root not found");

// Two public static pages route by path; everything else is the app. A tiny
// switch keeps us from pulling in a full router for two legal pages.
function routeFor(path: string) {
  if (path === "/privacy-policy") return <PrivacyPolicy />;
  if (path === "/terms-of-service") return <TermsOfService />;
  return <App />;
}

createRoot(rootEl).render(
  <StrictMode>{routeFor(window.location.pathname)}</StrictMode>,
);
