// Google OAuth (Sign in with Google): build the consent URL and exchange the
// callback code for a profile. Network calls go through the global `fetch`, so
// tests stub `fetch` -- no real Google traffic. Fails explicitly on any non-OK
// response or missing field.

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface GoogleProfile {
  googleSub: string;
  email: string;
  name: string;
}

export function googleConfigFromEnv(redirectUri: string): GoogleConfig {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId) throw new Error("Missing required env var: GOOGLE_CLIENT_ID");
  if (!clientSecret) {
    throw new Error("Missing required env var: GOOGLE_CLIENT_SECRET");
  }
  return { clientId, clientSecret, redirectUri };
}

export function buildAuthUrl(config: GoogleConfig, state: string): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: "openid email profile",
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export async function exchangeCode(
  config: GoogleConfig,
  code: string,
): Promise<GoogleProfile> {
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: "authorization_code",
    }).toString(),
  });
  if (!tokenRes.ok) {
    throw new Error(
      `Google token exchange failed: ${tokenRes.status} ${await tokenRes.text()}`,
    );
  }
  const token = (await tokenRes.json()) as { access_token?: string };
  if (!token.access_token) {
    throw new Error("Google token exchange returned no access_token.");
  }

  const infoRes = await fetch(
    "https://openidconnect.googleapis.com/v1/userinfo",
    { headers: { authorization: `Bearer ${token.access_token}` } },
  );
  if (!infoRes.ok) {
    throw new Error(
      `Google userinfo failed: ${infoRes.status} ${await infoRes.text()}`,
    );
  }
  const info = (await infoRes.json()) as {
    sub?: string;
    email?: string;
    name?: string;
  };
  if (!info.sub || !info.email) {
    throw new Error("Google userinfo response missing sub/email.");
  }
  return {
    googleSub: info.sub,
    email: info.email,
    name: info.name ?? info.email,
  };
}
