import { SyncIndex, emptyIndex } from "./sync/state";

export interface Settings {
  clientId: string;
  /**
   * Legacy plaintext copies. Secrets now live in Obsidian's SecretStorage; these
   * are only read during migration from older versions, then blanked.
   */
  clientSecret: string;
  refreshToken: string;
  /**
   * Random suffix for this vault's SecretStorage ids. Keeps two vaults on one
   * device from sharing secrets if the store turns out not to be per-vault.
   */
  secretIdSuffix: string;
  /**
   * True once this device has been linked (setup token, desktop sign-in, or a
   * migrated refresh token) and until it signs out. Lets a lost sign-in be told
   * apart from a device that was never linked or chose to sign out.
   */
  linked: boolean;

  rootFolderName: string;
  rootFolderId: string;

  deviceName: string;

  /** Extra user exclusions, one glob per line. */
  exclude: string[];
  /**
   * Sync the vault's config folder (`.obsidian/` by default) too. The plugin's own folder and per-device workspace
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

/**
 * Never synced. Workspace files are per-device layout, not content. The config
 * folder is whatever the vault says it is — Obsidian lets it be renamed, and a
 * hardcoded `.obsidian` would leave a renamed one synced.
 */
export function hardExcludes(configDir: string): string[] {
  return [
    `${configDir}/workspace.json`,
    `${configDir}/workspace-mobile.json`,
    ".trash/",
    ".git/",
    ".DS_Store",
  ];
}

export const DEFAULT_SETTINGS: Settings = {
  clientId: "",
  clientSecret: "",
  refreshToken: "",
  secretIdSuffix: "",
  linked: false,
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

/**
 * `pluginDir` and `configDir` are resolved at runtime rather than hardcoded. data.json there
 * holds the refresh token and client secret, and the folder name depends on how
 * the plugin was installed — a hardcoded guess that misses would upload the
 * credentials to Drive and to every linked device.
 */
export function effectiveExcludes(s: Settings, pluginDir: string, configDir: string): string[] {
  const base = [...hardExcludes(configDir), ...s.exclude, `${pluginDir}/`];
  if (!s.syncConfigFolder) base.push(`${configDir}/`);
  return base;
}
