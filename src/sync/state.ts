/**
 * The last state both sides agreed on. This is the "base" of the three-way
 * merge: without it, a file missing locally is indistinguishable from a file
 * deleted locally, which is how sync tools eat vaults.
 */
export interface IndexEntry {
  id: string;
  md5: string;
  size: number;
  /** Local mtime at the moment of the last successful sync. */
  mtime: number;
}

export type SyncIndex = Record<string, IndexEntry>;

export function emptyIndex(): SyncIndex {
  return {};
}
