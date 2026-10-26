import { DRIVE_SCOPE, TOKEN_ENDPOINT, TokenManager, buildAuthUrl } from "../src/auth/oauth";
import { setRequestUrlHandler } from "./obsidian-stub";
import { test, eq, run } from "./harness";

const FULL = "https://www.googleapis.com/auth/drive";
const FILE_ONLY = "https://www.googleapis.com/auth/drive.file";

const creds = {
  clientId: "cid.apps.googleusercontent.com",
  clientSecret: "secret-value-123",
  refreshToken: "1//refresh-value-456",
};

/** Answers the token endpoint with `json`; any other URL is a test failure. */
function answerToken(json: unknown): void {
  setRequestUrlHandler(async (req) => {
    const url = (req as { url?: string }).url;
    if (url !== TOKEN_ENDPOINT) throw new Error(`unexpected request to ${url}`);
    return { status: 200, json, text: JSON.stringify(json), headers: {} };
  });
}

function scopeOf(tm: TokenManager): boolean | null {
  return (tm as unknown as { hasFullDrive(): boolean | null }).hasFullDrive();
}

test("R6.1 the auth URL requests the drive scope", () => {
  const url = buildAuthUrl({
    clientId: creds.clientId,
    redirectUri: "http://127.0.0.1:53682/callback",
    state: "state-abc",
    codeChallenge: "challenge-xyz",
  });
  eq(new URL(url).searchParams.get("scope"), FULL, "scope query parameter");
  eq(DRIVE_SCOPE, FULL, "DRIVE_SCOPE");
});

test("R6.2 hasFullDrive reflects the last token response and resets on invalidate", async () => {
  const tm = new TokenManager(() => creds);
  const readings: Array<boolean | null> = [];

  readings.push(scopeOf(tm));

  answerToken({ access_token: "a1", expires_in: 3600, scope: FILE_ONLY });
  await tm.getAccessToken();
  readings.push(scopeOf(tm));

  tm.invalidate();
  readings.push(scopeOf(tm));

  answerToken({ access_token: "a2", expires_in: 3600, scope: FULL });
  await tm.getAccessToken();
  readings.push(scopeOf(tm));

  eq(readings, [null, false, null, true], "readings (before, after drive.file, after invalidate, after drive)");
});

test("R6.3 a response without a scope field leaves the scope unknown", async () => {
  const tm = new TokenManager(() => creds);
  answerToken({ access_token: "a3", expires_in: 3600 });
  await tm.getAccessToken();
  eq(scopeOf(tm), null, "hasFullDrive()");
});

void run().finally(() => setRequestUrlHandler(null));
