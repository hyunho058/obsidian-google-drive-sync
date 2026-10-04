import { TOKEN_ENDPOINT, VerifyError, verifyCredentials } from "../src/auth/oauth";
import { setRequestUrlHandler } from "./obsidian-stub";
import { test, eq, assert, rejects, run } from "./harness";

const creds = {
  clientId: "cid.apps.googleusercontent.com",
  clientSecret: "secret-value-123",
  refreshToken: "1//refresh-value-456",
};

/** Answers every requestUrl call with `status` and a JSON body. */
function answer(status: number, json: unknown): void {
  setRequestUrlHandler(async () => ({ status, json, text: JSON.stringify(json), headers: {} }));
}

async function failure(): Promise<VerifyError> {
  const err = await rejects(() => verifyCredentials(creds, 2000), "verifyCredentials");
  assert(err instanceof VerifyError, `not a VerifyError: ${err.message}`);
  assert(!err.message.includes(creds.clientSecret), "message contains the client secret");
  assert(!err.message.includes(creds.refreshToken), "message contains the refresh token");
  return err as VerifyError;
}

test("R10.1 the check is a refresh grant carrying the decrypted credentials", async () => {
  let seen: { url?: string; method?: string; body?: string } = {};
  setRequestUrlHandler(async (req) => {
    seen = req as typeof seen;
    return { status: 200, json: { access_token: "a", expires_in: 3600 }, text: "", headers: {} };
  });
  await verifyCredentials(creds, 2000);
  eq(seen.url, TOKEN_ENDPOINT, "endpoint");
  eq(seen.method, "POST", "method");
  const body = new URLSearchParams(seen.body ?? "");
  eq(body.get("grant_type"), "refresh_token", "grant type");
  eq(body.get("client_id"), creds.clientId, "client id");
  eq(body.get("client_secret"), creds.clientSecret, "client secret");
  eq(body.get("refresh_token"), creds.refreshToken, "refresh token");
});

test("R10.4 invalid_grant means Google rejected the sign-in", async () => {
  answer(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." });
  const err = await failure();
  eq(err.kind, "rejected", "kind");
  eq(
    err.message,
    "Google rejected this sign-in. On your other device, sign in again and copy a new token.",
    "message",
  );
});

test("R10.4 other 4xx answers (invalid_client) are rejections too", async () => {
  answer(401, { error: "invalid_client" });
  eq((await failure()).kind, "rejected", "kind");
});

test("an outage (429 or 5xx) is reported as unavailable, not as a bad token", async () => {
  for (const status of [429, 500, 503]) {
    answer(status, { error: "backendError" });
    const err = await failure();
    eq(err.kind, "unavailable", `kind for ${status}`);
    eq(err.message, "Google is temporarily unavailable — try again in a minute.", `message for ${status}`);
  }
});

test("R10.3 a transport failure means Google could not be reached", async () => {
  setRequestUrlHandler(async () => {
    throw new Error("net::ERR_INTERNET_DISCONNECTED");
  });
  const err = await failure();
  eq(err.kind, "network", "kind");
  eq(err.message, "Couldn't reach Google — check your connection and try again.", "message");
});

test("R10.3 no answer within the timeout counts as unreachable", async () => {
  setRequestUrlHandler(() => new Promise(() => undefined));
  const started = Date.now();
  const err = await rejects(() => verifyCredentials(creds, 50), "verifyCredentials");
  assert(err instanceof VerifyError && err.kind === "network", "not a network VerifyError");
  assert(Date.now() - started < 1000, "timeout did not fire promptly");
});

void run().finally(() => setRequestUrlHandler(null));
