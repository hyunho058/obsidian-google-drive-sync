export const FOLDER_MIME = "application/vnd.google-apps.folder";
/** Docs, Sheets, shortcuts and the like: no bytes to download, so never synced. */
export const GOOGLE_APPS_PREFIX = "application/vnd.google-apps.";

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  md5Checksum?: string;
  size?: string;
  modifiedTime?: string;
  parents?: string[];
  trashed?: boolean;
}

export const FILE_FIELDS = "id,name,mimeType,md5Checksum,size,modifiedTime,parents,trashed";

/** A remote file resolved to a vault-relative path. */
export interface RemoteEntry {
  path: string;
  id: string;
  md5: string | null;
  size: number;
  modifiedTime: number;
}

/** What a single `files.get` says about a folder someone wants to sync with. */
export interface FolderInspection {
  id: string;
  name: string;
  isFolder: boolean;
  trashed: boolean;
  /** `capabilities.canAddChildren`: sync is two-way, so a view-only folder is unusable. */
  writable: boolean;
}
