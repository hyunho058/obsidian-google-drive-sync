/**
 * Whether Obsidian's "Deleted files" setting keeps a copy: "system" (system
 * trash) or "local" (the vault's `.trash`). "none" deletes permanently. The
 * setting is not in the public typings, so anything unreadable counts as no.
 */
export function keepsDeletedCopy(vault: unknown): boolean {
  const getConfig = (vault as { getConfig?: (key: string) => unknown } | null)?.getConfig;
  if (typeof getConfig !== "function") return false;
  try {
    const option = getConfig.call(vault, "trashOption");
    return option === "system" || option === "local";
  } catch {
    return false;
  }
}
