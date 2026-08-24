export interface JournaledFileEvidence {
  path: string;
  exists: boolean;
  uid: number | null;
  gid: number | null;
  mode: number | null;
  sha256: string | null;
}

export interface JournaledUnitFile {
  path: string;
  intended_sha256: string;
  original: JournaledFileEvidence;
  backup_path: string;
  state: "prepared" | "installed";
}

export type JournaledUnitFileAction = "backup_original" | "write_intended" | "mark_installed" | "complete";

function matchesOriginal(current: JournaledFileEvidence, original: JournaledFileEvidence) {
  if (current.exists !== original.exists) return false;
  if (!current.exists) return true;
  return current.sha256 === original.sha256
    && current.uid === original.uid
    && current.gid === original.gid
    && current.mode === original.mode;
}

export function nextJournaledUnitFileAction(
  record: JournaledUnitFile,
  current: JournaledFileEvidence,
  backup: JournaledFileEvidence,
): JournaledUnitFileAction {
  if (record.state === "installed") {
    if (current.exists && current.sha256 === record.intended_sha256) return "complete";
    throw new Error(`Installed unit drop-in ${record.path} drifted outside the cutover journal.`);
  }
  if (record.original.exists) {
    if (!backup.exists) {
      if (matchesOriginal(current, record.original)) return "backup_original";
      throw new Error(`Unit drop-in backup is missing after ${record.path} changed.`);
    }
    if (backup.sha256 !== record.original.sha256) {
      throw new Error(`Unit drop-in backup does not match the original ${record.path}.`);
    }
  } else if (backup.exists) {
    throw new Error(`Unexpected unit drop-in backup exists for originally absent ${record.path}.`);
  }
  if (current.exists && current.sha256 === record.intended_sha256) return "mark_installed";
  if (matchesOriginal(current, record.original)) return "write_intended";
  throw new Error(`Unit drop-in ${record.path} changed outside the cutover journal.`);
}

