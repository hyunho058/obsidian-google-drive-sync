// Runtime stub so pure-logic modules can be bundled for node without Obsidian.

type RequestHandler = (req: unknown) => Promise<unknown>;
let requestHandler: RequestHandler | null = null;

/** Lets a test answer `requestUrl` calls; pass null to restore the default. */
export function setRequestUrlHandler(handler: RequestHandler | null): void {
  requestHandler = handler;
}

export function requestUrl(req: unknown): Promise<unknown> {
  if (!requestHandler) throw new Error("requestUrl is not available in tests");
  return requestHandler(req);
}

export class Notice {}
