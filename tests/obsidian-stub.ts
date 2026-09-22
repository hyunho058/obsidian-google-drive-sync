// Runtime stub so pure-logic modules can be bundled for node without Obsidian.
export function requestUrl(): never {
  throw new Error("requestUrl is not available in tests");
}
export class Notice {}
