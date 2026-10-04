/**
 * Minimal async-capable test harness. Test files are bundled to CommonJS, which
 * has no top-level await, so cases are registered with `test()` and executed
 * by `run()` at the end of the file.
 */

type Case = { name: string; fn: () => void | Promise<void> };

const cases: Case[] = [];

export function test(name: string, fn: () => void | Promise<void>): void {
  cases.push({ name, fn });
}

export function eq(actual: unknown, expected: unknown, what = "value"): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what}\n     expected ${e}\n     actual   ${a}`);
}

export function assert(cond: unknown, what: string): void {
  if (!cond) throw new Error(what);
}

/** Resolves with the thrown error so callers can inspect its message. */
export async function rejects(fn: () => unknown, what: string): Promise<Error> {
  try {
    await fn();
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e));
  }
  throw new Error(`${what}: expected a rejection, got none`);
}

export async function run(): Promise<void> {
  let passed = 0;
  const failures: string[] = [];
  for (const c of cases) {
    try {
      await c.fn();
      passed++;
    } catch (e) {
      failures.push(`${c.name}\n     ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  console.log(`\n${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log(`  FAIL ${f}`);
  if (failures.length > 0) process.exitCode = 1;
}
