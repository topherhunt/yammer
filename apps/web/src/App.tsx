import type { StoreApi } from "zustand/vanilla";
import type { AppStore } from "./store/store";
import { getDefaultStore } from "./store/default-store";
import { StoreProvider } from "./store/context";
import { AppShell } from "./components/AppShell";
import { AuthGate } from "./components/AuthGate";

// Root. Tests (and any embedder) inject a store and render the shell directly.
// The real app gates on sign-in first, then lazily builds the default store (so
// the heavy voice pipeline import only happens once authenticated).

export function App({ store }: { store?: StoreApi<AppStore> } = {}) {
  if (store) {
    return (
      <StoreProvider store={store}>
        <AppShell />
      </StoreProvider>
    );
  }
  return (
    <AuthGate>
      <DefaultApp />
    </AuthGate>
  );
}

function DefaultApp() {
  const store = getDefaultStore();
  return (
    <StoreProvider store={store}>
      <AppShell />
    </StoreProvider>
  );
}
