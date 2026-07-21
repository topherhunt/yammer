import { useEffect } from "react";
import type { Theme } from "@yammer/shared";

// Applies the theme to <html> as the `dark` class (Tailwind darkMode:'class').
// "system" follows the OS via prefers-color-scheme and updates live when the OS
// setting changes; "light"/"dark" pin it.

function apply(dark: boolean): void {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle("dark", dark);
}

export function useTheme(theme: Theme): void {
  useEffect(() => {
    if (theme !== "system") {
      apply(theme === "dark");
      return;
    }
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    apply(mql.matches);
    const onChange = (e: MediaQueryListEvent) => apply(e.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [theme]);
}
