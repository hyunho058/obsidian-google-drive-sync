import { buildAuthUrl, exchangeCode } from "./oauth";
import { challengeFor, randomToken } from "./pkce";

/**
 * Desktop-only interactive sign-in.
 *
 * Google rejects custom schemes like `obsidian://` for every client type, so a
 * Desktop-app client with a loopback redirect is the only flow that works
 * without a server. Loopback needs a listening socket, which iOS does not
 * provide — hence the setup-token transfer for the phone.
 *
 * `http` is reached through `window.require`, which exists only in the Electron
 * renderer. On iOS this module's exported function is never called, and the
 * lookup would fail loudly rather than silently bundling a Node builtin.
 */

interface NodeRequest {
  url?: string;
}

interface NodeResponse {
  writeHead(status: number, headers: Record<string, string>): void;
  end(body?: string): void;
}

interface NodeServer {
  listen(port: number, host: string, cb: () => void): void;
  address(): { port: number } | string | null;
  close(cb?: () => void): void;
  on(event: string, cb: (err: unknown) => void): void;
}

interface NodeHttp {
  createServer(handler: (req: NodeRequest, res: NodeResponse) => void): NodeServer;
}

function loadNodeModule<T>(id: string): T {
  const req = (window as unknown as { require?: (id: string) => unknown }).require;
  if (typeof req !== "function") {
    throw new Error(
      "Interactive sign-in is only available on desktop. On mobile, paste a setup " +
        "token copied from the desktop app instead.",
    );
  }
  return req(id) as T;
}

function openExternal(url: string): void {
  try {
    const electron = loadNodeModule<{ shell?: { openExternal(u: string): void } }>("electron");
    if (electron.shell) {
      electron.shell.openExternal(url);
      return;
    }
  } catch {
    /* fall through */
  }
  window.open(url, "_blank");
}

const PAGE = (title: string, detail: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font-family:-apple-system,system-ui,sans-serif;max-width:32rem;margin:6rem auto;padding:0 1.5rem;line-height:1.6">` +
  `<h1 style="font-size:1.25rem">${title}</h1><p style="color:#555">${detail}</p></body>`;

export interface LoopbackResult {
  refreshToken: string;
}

export function runLoopbackFlow(opts: {
  clientId: string;
  clientSecret: string;
  timeoutMs?: number;
  onUrl?: (url: string) => void;
}): Promise<LoopbackResult> {
  const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;

  return new Promise<LoopbackResult>((resolve, reject) => {
    const http = loadNodeModule<NodeHttp>("http");
    const state = randomToken(24);
    const verifier = randomToken(48);

    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const server: NodeServer = http.createServer((req, res) => {
      const raw = req.url ?? "/";
      // Any loopback port is accepted for a Desktop-app client, so the origin
      // here is only ever our own ephemeral port.
      const url = new URL(raw, "http://127.0.0.1");
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      const gotState = url.searchParams.get("state");

      if (!code && !error) {
        res.writeHead(204, {});
        res.end();
        return;
      }

      if (error) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(PAGE("Sign-in cancelled", `Google reported: ${error}`));
        finish(new Error(`Google returned an error: ${error}`), null);
        return;
      }

      if (gotState !== state) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(PAGE("Sign-in rejected", "The state parameter did not match."));
        finish(new Error("OAuth state mismatch — sign-in was not completed."), null);
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(PAGE("Signed in", "You can close this tab and return to Obsidian."));
      finish(null, code);
    });

    const finish = (err: Error | null, code: string | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      server.close();

      if (err || !code) {
        reject(err ?? new Error("Sign-in did not complete."));
        return;
      }

      exchangeCode({
        clientId: opts.clientId,
        clientSecret: opts.clientSecret,
        code,
        codeVerifier: verifier,
        redirectUri: `http://127.0.0.1:${port}`,
      })
        .then((refreshToken) => resolve({ refreshToken }))
        .catch(reject);
    };

    server.on("error", (e) => finish(new Error(`Could not start the local listener: ${String(e)}`), null));

    // Port 0 asks the OS for a free port; Desktop-app clients accept any
    // loopback port, so nothing has to be registered in Google Cloud.
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      if (!port) {
        finish(new Error("Could not determine the local port."), null);
        return;
      }

      challengeFor(verifier)
        .then((codeChallenge) => {
          const url = buildAuthUrl({
            clientId: opts.clientId,
            redirectUri: `http://127.0.0.1:${port}`,
            state,
            codeChallenge,
          });
          opts.onUrl?.(url);
          openExternal(url);
          timer = setTimeout(
            () => finish(new Error("Sign-in timed out after 5 minutes."), null),
            timeoutMs,
          );
        })
        .catch((e) => finish(e instanceof Error ? e : new Error(String(e)), null));
    });
  });
}
