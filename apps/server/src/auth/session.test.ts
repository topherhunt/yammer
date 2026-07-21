import { describe, it, expect } from "vitest";
import { signSession, verifySession } from "./session";

const SECRET = "unit-secret";

describe("session cookie signing", () => {
  it("round-trips a user id through sign/verify", () => {
    const token = signSession("user-42", SECRET);
    expect(verifySession(token, SECRET)).toBe("user-42");
  });

  it("rejects a token signed with a different secret", () => {
    const token = signSession("user-42", SECRET);
    expect(verifySession(token, "other-secret")).toBeNull();
  });

  it("rejects a tampered payload", () => {
    const token = signSession("user-42", SECRET);
    const [, sig] = token.split(".");
    const forged = `${Buffer.from(JSON.stringify({ uid: "admin", iat: Date.now() })).toString("base64url")}.${sig}`;
    expect(verifySession(forged, SECRET)).toBeNull();
  });

  it("rejects a token older than the max age", () => {
    const old = signSession("user-42", SECRET, Date.now() - 1000 * 60);
    expect(verifySession(old, SECRET, 1000)).toBeNull();
  });

  it("rejects malformed tokens", () => {
    expect(verifySession("garbage", SECRET)).toBeNull();
    expect(verifySession(".onlyasig", SECRET)).toBeNull();
    expect(verifySession("", SECRET)).toBeNull();
  });
});
