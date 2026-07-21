import { afterEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { AuthGate } from "./AuthGate";

afterEach(() => vi.unstubAllGlobals());

describe("AuthGate", () => {
  it("shows the sign-in screen (not the app) when /api/me is unauthenticated", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 }));
    const { container } = render(
      <AuthGate>
        <div className="qa-app-content">app</div>
      </AuthGate>,
    );
    await waitFor(() =>
      expect(container.querySelector(".qa-signin")).not.toBeNull(),
    );
    expect(container.querySelector(".qa-app-content")).toBeNull();
    const link = container.querySelector(".qa-signin") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/auth/google");
  });

  it("renders the app when /api/me is authenticated", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    const { container } = render(
      <AuthGate>
        <div className="qa-app-content">app</div>
      </AuthGate>,
    );
    await waitFor(() =>
      expect(container.querySelector(".qa-app-content")).not.toBeNull(),
    );
  });
});
