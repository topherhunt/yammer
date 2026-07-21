import { afterEach, beforeAll, describe, it, expect, vi } from "vitest";
import { buildApp } from "../app";
import { createTestDb, FakeLlm, FakeSearch } from "../test-support";
import { buildAuthUrl, exchangeCode } from "./google";

beforeAll(() => {
  process.env.SESSION_SECRET = "test-secret-please-ignore";
  process.env.GOOGLE_CLIENT_ID = "client-id";
  process.env.GOOGLE_CLIENT_SECRET = "client-secret";
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Stub global fetch: first call = token endpoint, second = userinfo endpoint. */
function stubGoogleFetch(profile: { sub: string; email: string; name: string }) {
  const fetchMock = vi.fn(async (url: string | URL | Request) => {
    const href = typeof url === "string" ? url : url.toString();
    if (href.includes("oauth2.googleapis.com/token")) {
      return new Response(JSON.stringify({ access_token: "at-123" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (href.includes("openidconnect.googleapis.com/v1/userinfo")) {
      return new Response(JSON.stringify(profile), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch to ${href}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("buildAuthUrl", () => {
  it("builds a Google consent URL with our client id, scopes, and state", () => {
    const url = new URL(
      buildAuthUrl(
        { clientId: "cid", clientSecret: "sec", redirectUri: "https://app/cb" },
        "state-xyz",
      ),
    );
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("redirect_uri")).toBe("https://app/cb");
    expect(url.searchParams.get("scope")).toBe("openid email profile");
    expect(url.searchParams.get("state")).toBe("state-xyz");
  });
});

describe("exchangeCode", () => {
  it("exchanges a code for a normalized Google profile", async () => {
    stubGoogleFetch({ sub: "google-sub-1", email: "ada@x.com", name: "Ada" });
    const profile = await exchangeCode(
      { clientId: "cid", clientSecret: "sec", redirectUri: "https://app/cb" },
      "auth-code",
    );
    expect(profile).toEqual({ googleSub: "google-sub-1", email: "ada@x.com", name: "Ada" });
  });

  it("throws loudly when Google returns a non-OK token response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 400 })),
    );
    await expect(
      exchangeCode({ clientId: "cid", clientSecret: "sec", redirectUri: "https://app/cb" }, "bad"),
    ).rejects.toThrow(/token exchange failed/);
  });
});

describe("OAuth callback route", () => {
  it("creates a user on first login and sets a session cookie", async () => {
    stubGoogleFetch({ sub: "google-sub-2", email: "new@x.com", name: "New User" });
    const { repos } = createTestDb();
    const app = buildApp({ repos, llm: new FakeLlm(), search: new FakeSearch() });

    const res = await app.request("/auth/google/callback?code=abc&state=st", {
      headers: { cookie: "yammer_oauth_state=st" },
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("set-cookie")).toContain("yammer_session=");

    const user = await repos.users.findByGoogleSub("google-sub-2");
    expect(user?.email).toBe("new@x.com");
  });

  it("rejects a callback whose state does not match the cookie", async () => {
    const { repos } = createTestDb();
    const app = buildApp({ repos, llm: new FakeLlm(), search: new FakeSearch() });
    const res = await app.request("/auth/google/callback?code=abc&state=evil", {
      headers: { cookie: "yammer_oauth_state=st" },
      redirect: "manual",
    });
    expect(res.status).toBe(400);
  });
});
