import { SyncIndex, emptyIndex } from "./sync/state";

export interface Settings {
  clientId: string;
  clientSecret: string;
  refreshToken: string;

  rootFolderName: string;
  rootFolderId: string;

  deviceName: string;

  /** Extra user exclusions, one glob per line. */
  exclude: string[];
  /**
   * Sync `.obsidian/` too. The plugin's own folder and per-device workspace
   * files stay excluded regardless — they hold the refresh token and this
   * device's pane layout.
   */
  syncConfigFolder: boolean;

  autoSync: boolean;
  intervalMinutes: number;
  syncOnFocus: boolean;
  debounceSeconds: number;

  maxFileMB: number;
  deletionGuardRatio: number;
  concurrency: number;
  verbose: boolean;

  index: SyncIndex;
  changeToken: string;
  lastSync: number;
}

/** Never synced. data.json here holds the refresh token; workspace files are per-device. */
export const HARD_EXCLUDES = [
  ".obsidian/plugins/gdrive-vault-sync/",
  ".obsidian/workspace.json",
  ".obsidian/workspace-mobile.json",
  ".trash/",
  ".git/",
  ".DS_Store",
];

export const DEFAULT_SETTINGS: Settings = {
  clientId: "",
  clientSecret: "",
  refreshToken: "",
  rootFolderName: "",
  rootFolderId: "",
  deviceName: "",
  exclude: [],
  syncConfigFolder: false,
  autoSync: true,
  intervalMinutes: 5,
  syncOnFocus: true,
  debounceSeconds: 10,
  maxFileMB: 100,
  deletionGuardRatio: 0.2,
  concurrency: 4,
  verbose: false,
  index: emptyIndex(),
  changeToken: "",
  lastSync: 0,
};

export function effectiveExcludes(s: Settings): string[] {
  const base = [...HARD_EXCLUDES, ...s.exclude];
  if (!s.syncConfigFolder) base.push(".obsidian/");
  return base;
}
