/**
 * Deciding whether the Drive change feed says anything about the synced tree.
 *
 * With full Drive access the feed reports every change in the account, so an
 * unfiltered probe would walk the whole vault for an edit anywhere else.
 */

/** Consecutive quiet probes before a full walk is forced: about an hour at the 5-minute default. */
const SWEEP_EVERY = 12;

/**
 * True when the change touches the tree: an edit, removal or trashing of a
 * known file or folder, or anything whose parent is a known folder (new
 * children and moves in). Moves out are caught by the known id.
 */
export function relevantChange(
  change: { fileId?: string; removed?: boolean; file?: { id?: string; parents?: string[]; trashed?: boolean } },
  knownIds: Set<string>,
  knownFolders: Set<string>,
): boolean {
  const id = change.fileId ?? change.file?.id;
  if (id !== undefined && (knownIds.has(id) || knownFolders.has(id))) return true;
  // A removal carries no file, so an unknown id is all there is to judge by.
  if (change.removed) return false;
  return (change.file?.parents ?? []).some((p) => knownFolders.has(p));
}

/**
 * Counts probes in a row that found nothing. The feed may leave out changes
 * to files other people own, so a quiet streak periodically yields to a full
 * walk. Session-only on purpose: every session starts with a full walk anyway.
 */
export class QuietProbes {
  private streak = 0;

  quiet(): void {
    this.streak++;
  }

  /** Call after every full walk, so the forced sweep never repeats back to back. */
  changed(): void {
    this.streak = 0;
  }

  forceSweep(): boolean {
    return this.streak > 0 && this.streak % SWEEP_EVERY === 0;
  }
}
