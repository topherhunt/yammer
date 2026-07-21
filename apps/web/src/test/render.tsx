import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import type { AppState } from "@yammer/shared";
import { MockApiClient } from "../api/mock-client";
import type { MockApiConfig } from "../api/mock-client";
import { MockStt } from "../stt/mock-stt";
import { createAppStore } from "../store/store";
import { StoreProvider } from "../store/context";

// Test harness: build a store on mocks with deterministic ids/clock and render
// a subtree inside its provider. Returns the store + mocks so tests can drive
// STT, inspect backend calls, and assert on rendered output.

export function makeTestStore(config: { api?: MockApiConfig; initial?: Partial<AppState> } = {}) {
  const api = new MockApiClient(config.api);
  const stt = new MockStt();
  let n = 0;
  const store = createAppStore({
    api,
    stt,
    newId: () => `id-${++n}`,
    now: () => "2026-01-01T00:00:00.000Z",
    initial: config.initial,
  });
  return { store, api, stt };
}

export function renderWithStore(
  ui: ReactElement,
  config: { api?: MockApiConfig; initial?: Partial<AppState> } = {},
) {
  const harness = makeTestStore(config);
  const result = render(<StoreProvider store={harness.store}>{ui}</StoreProvider>);
  return { ...harness, ...result };
}
