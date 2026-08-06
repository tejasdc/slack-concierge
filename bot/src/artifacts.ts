import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export interface ArtifactFile {
  path: string;
  filename: string;
  mtimeMs: number;
}

export function findNewArtifacts(cwd: string, sinceMs: number): ArtifactFile[] {
  const dir = join(cwd, ".artifacts");
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
        if (!stat.isFile() || stat.mtimeMs <= sinceMs) return null;
        return { path, filename, mtimeMs: stat.mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((item): item is ArtifactFile => item !== null)
    .sort((a, b) => a.mtimeMs - b.mtimeMs);
}
