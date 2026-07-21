import { createContext, useContext } from "react";
import type { ReactNode } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import type { AppStore } from "./store";

// React binding for the vanilla store. A provider carries a store instance so
// tests can mount the tree against a fresh store with injected mocks, while the
// real app uses the module singleton (see default-store.ts).

const StoreContext = createContext<StoreApi<AppStore> | null>(null);

export function StoreProvider({
  store,
  children,
}: {
  store: StoreApi<AppStore>;
  children: ReactNode;
}) {
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

export function useStoreApi(): StoreApi<AppStore> {
  const store = useContext(StoreContext);
  if (!store) throw new Error("useStoreApi must be used within a StoreProvider");
  return store;
}

export function useAppStore<T>(selector: (state: AppStore) => T): T {
  return useStore(useStoreApi(), selector);
}
