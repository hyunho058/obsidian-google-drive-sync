const PREFIX = "[gdrive-sync]";

export class Logger {
  constructor(private verbose: () => boolean) {}

  debug(...args: unknown[]): void {
    if (this.verbose()) console.log(PREFIX, ...args);
  }

  warn(...args: unknown[]): void {
    console.warn(PREFIX, ...args);
  }

  error(...args: unknown[]): void {
    console.error(PREFIX, ...args);
  }
}

export function describeError(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}
