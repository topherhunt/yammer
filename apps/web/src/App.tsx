import type { StoreApi } from "zustand/vanilla";
import type { AppStore } from "./store/store";
import { getDefaultStore } from "./store/default-store";
import { StoreProvider } from "./store/context";
import { AppShell } from "./components/AppShell";

// Root: wires a store (the module default for the real app, or an injected one
// for tests) into the provider and renders the shell.

export function App({ store }: { store?: StoreApi<AppStore> } = {}) {
  const s = store ?? getDefaultStore();
  return (
    <StoreProvider store={s}>
      <AppShell />
    </StoreProvider>
  );
}
