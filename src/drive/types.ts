export const FOLDER_MIME = "application/vnd.google-apps.folder";

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
