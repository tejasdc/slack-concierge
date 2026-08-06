import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export interface ArtifactFile {
  path: string;
  filename: string;
  mtimeMs: number;
  ctimeMs: number;
}

export const ARTIFACT_SCAN_GRACE_MS = 5_000;

export function findNewArtifacts(cwd: string, sinceMs: number): ArtifactFile[] {
  const dir = join(cwd, ".artifacts");
  const floorMs = sinceMs - ARTIFACT_SCAN_GRACE_MS;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }

  return names
    .map((filename) => {
      const path = join(dir, filename);
      try {
        const stat = statSync(path);
        if (!stat.isFile() || (stat.mtimeMs < floorMs && stat.ctimeMs < floorMs)) return null;
        return { path, filename, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
      } catch {
        return null;
      }
    })
    .filter((item): item is ArtifactFile => item !== null)
    .sort((a, b) => a.mtimeMs - b.mtimeMs);
}
