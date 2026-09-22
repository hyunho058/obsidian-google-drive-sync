import { requestUrl } from "obsidian";

export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
export const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";

export interface Credentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export class AuthError extends Error {
  constructor(message: string, readonly fatal: boolean) {
    super(message);
    this.name = "AuthError";
  }
}

function form(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
}

async function postToken(params: Record<string, string>): Promise<TokenResponse> {
  const res = await requestUrl({
    url: TOKEN_ENDPOINT,
    method: "POST",
    contentType: "application/x-www-form-urlencoded",
    body: form(params),
    throw: false,
  });

  if (res.status >= 400) {
    let code = "";
    let desc = "";
    try {
      const j = res.json as { error?: string; error_description?: string };
      code = j.error ?? "";
      desc = j.error_description ?? "";
    } catch {
      desc = res.text;
    }
    if (code === "invalid_grant") {
      throw new AuthError(
        "Google rejected the refresh token (invalid_grant). The usual cause is an " +
          "OAuth consent screen still in Testing status — those refresh tokens expire " +
          "after 7 days. Set the consent screen to In production, then sign in again.",
        true,
      );
    }
    throw new AuthError(`Token request failed (${res.status}): ${code} ${desc}`.trim(), false);
  }

  return res.json as TokenResponse;
}

export async function exchangeCode(opts: {
  clientId: string;
  clientSecret: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<string> {
  const tokens = await postToken({
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    code: opts.code,
    code_verifier: opts.codeVerifier,
    redirect_uri: opts.redirectUri,
    grant_type: "authorization_code",
  });

  if (!tokens.refresh_token) {
    throw new AuthError(
      "Google returned no refresh token. Revoke this app at " +
        "myaccount.google.com/permissions and sign in again.",
      true,
    );
  }
  return tokens.refresh_token;
}

export function buildAuthUrl(opts: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  return (
    `${AUTH_ENDPOINT}?` +
    form({
      client_id: opts.clientId,
      redirect_uri: opts.redirectUri,
      response_type: "code",
      scope: DRIVE_SCOPE,
      state: opts.state,
      code_challenge: opts.codeChallenge,
      code_challenge_method: "S256",
      access_type: "offline",
      prompt: "consent",
    })
  );
}

/**
 * Caches an access token and refreshes it on demand. This is the only auth work
 * the phone ever does — a plain HTTPS POST through `requestUrl`, no loopback
 * listener, no Node.
 */
export class TokenManager {
  private accessToken: string | null = null;
  private expiresAt = 0;
  private inFlight: Promise<string> | null = null;

  constructor(private credentials: () => Credentials | null) {}

  invalidate(): void {
    this.accessToken = null;
    this.expiresAt = 0;
  }

  async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.expiresAt) return this.accessToken;
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.refresh().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async refresh(): Promise<string> {
    const creds = this.credentials();
    if (!creds || !creds.refreshToken) {
      throw new AuthError("Not signed in to Google Drive yet.", true);
    }

    const tokens = await postToken({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      refresh_token: creds.refreshToken,
      grant_type: "refresh_token",
    });

    this.accessToken = tokens.access_token;
    // Refresh a minute early so a request never races the expiry.
    this.expiresAt = Date.now() + Math.max(0, tokens.expires_in - 60) * 1000;
    return this.accessToken;
  }
}
