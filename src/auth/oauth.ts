import { requestUrl } from "obsidian";

// Full Drive instead of drive.file: a folder shared by someone else, and files collaborators
// add to it later, were never created or opened by this app, so drive.file can't see them.
export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";
export const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";

export interface Credentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export class AuthError extends Error {
  /** `status` is the HTTP status when Google answered with an error. */
  constructor(message: string, readonly fatal: boolean, readonly status?: number) {
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
  /** Space-separated scopes this token carries; Google sends it on refresh grants too. */
  scope?: string;
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
        res.status,
      );
    }
    throw new AuthError(`Token request failed (${res.status}): ${code} ${desc}`.trim(), false, res.status);
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

export type VerifyFailure = "network" | "unavailable" | "rejected";

const VERIFY_MESSAGES: Record<VerifyFailure, string> = {
  network: "Couldn't reach Google — check your connection and try again.",
  unavailable: "Google is temporarily unavailable — try again in a minute.",
  rejected: "Google rejected this sign-in. On your other device, sign in again and copy a new token.",
};

/** Why `verifyCredentials` failed; its message is fixed user-facing text. */
export class VerifyError extends Error {
  constructor(readonly kind: VerifyFailure) {
    super(VERIFY_MESSAGES[kind]);
    this.name = "VerifyError";
  }
}

/**
 * Only a 4xx answer means Google refused these credentials. Rate limiting
 * (429) and server errors (5xx) say nothing about the token, so telling the
 * user to copy a new one would be wrong.
 */
function classify(e: unknown): VerifyFailure {
  if (!(e instanceof AuthError) || e.status === undefined) return "network";
  if (e.status === 429 || e.status >= 500) return "unavailable";
  return "rejected";
}

/**
 * Asks Google for an access token with credentials that are not saved yet, so a
 * link is only committed once Google accepts them. `requestUrl` has no timeout
 * of its own; a request still running after `timeoutMs` counts as unreachable
 * and its eventual answer is ignored.
 */
export async function verifyCredentials(creds: Credentials, timeoutMs = 30_000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new VerifyError("network")), timeoutMs);
  });
  try {
    await Promise.race([
      postToken({
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        refresh_token: creds.refreshToken,
        grant_type: "refresh_token",
      }),
      timeout,
    ]);
  } catch (e) {
    if (e instanceof VerifyError) throw e;
    throw new VerifyError(classify(e));
  } finally {
    if (timer) clearTimeout(timer);
  }
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
  // Read from Google's answer rather than saved at sign-in, so a sign-in made before 0.3.0,
  // which used to request drive.file, is recognised too.
  private grantedScope: string | null = null;

  constructor(private credentials: () => Credentials | null) {}

  invalidate(): void {
    this.accessToken = null;
    this.expiresAt = 0;
    // A new sign-in may carry a different scope; don't let the old one's answer linger.
    this.grantedScope = null;
  }

  /**
   * Whether the current sign-in can see the whole Drive. `null` means unknown: no token
   * fetched since the last `invalidate()`, or Google's answer named no scope.
   */
  hasFullDrive(): boolean | null {
    if (this.grantedScope === null) return null;
    // Exact match: "drive.file" and "drive.readonly" share the prefix but can't see shared folders.
    return this.grantedScope.split(/\s+/).includes(DRIVE_SCOPE);
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
    this.grantedScope = tokens.scope ?? null;
    // Refresh a minute early so a request never races the expiry.
    this.expiresAt = Date.now() + Math.max(0, tokens.expires_in - 60) * 1000;
    return this.accessToken;
  }
}
