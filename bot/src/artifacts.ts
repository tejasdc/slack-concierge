import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  createReadStream,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";

export interface ArtifactFile {
  path: string;
  filename: string;
  mtimeMs: number;
  size: number;
  device: string;
  inode: string;
  sha256: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validateTurnIdentity(turnId: number, ownershipToken: string) {
  if (!Number.isSafeInteger(turnId) || turnId <= 0) {
    throw new Error(`Artifact delivery requires a positive integer turn ID, received ${turnId}.`);
  }
  if (!UUID_PATTERN.test(ownershipToken)) {
    throw new Error("Artifact delivery requires a persisted UUID ownership token.");
  }
}

function assertRealDirectory(path: string, label: string) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} must be a real directory and may not be a symbolic link: ${path}`);
  }
}

function ensureArtifactRoot(cwd: string) {
  const root = join(cwd, ".artifacts");
  if (!existsSync(root)) mkdirSync(root, { mode: 0o700 });
  assertRealDirectory(root, "Artifact root");
  return root;
}

function hashOpenedFile(fd: number, size: number) {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let offset = 0;
  while (offset < size) {
    const bytesRead = readSync(fd, buffer, 0, Math.min(buffer.length, size - offset), offset);
    if (bytesRead === 0) throw new Error("Artifact changed while its immutable identity was recorded.");
    hash.update(buffer.subarray(0, bytesRead));
    offset += bytesRead;
  }
  return hash.digest("hex");
}

function inspectOpenedArtifact(path: string, filename: string): ArtifactFile {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`Artifact is not a regular file: ${path}`);
    return {
      path,
      filename,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      device: String(stat.dev),
      inode: String(stat.ino),
      sha256: hashOpenedFile(fd, stat.size),
    };
  } finally {
    closeSync(fd);
  }
}

function openedArtifactMatches(fd: number, artifact: ArtifactFile) {
  const stat = fstatSync(fd);
  return stat.isFile()
    && stat.size === artifact.size
    && String(stat.dev) === artifact.device
    && String(stat.ino) === artifact.inode
    && hashOpenedFile(fd, stat.size) === artifact.sha256;
}

export function artifactDirectoryForTurn(cwd: string, turnId: number, ownershipToken: string) {
  validateTurnIdentity(turnId, ownershipToken);
  return join(cwd, ".artifacts", `turn-${turnId}-${ownershipToken}`);
}

export function prepareArtifactDirectory(cwd: string, turnId: number, ownershipToken: string) {
  const root = ensureArtifactRoot(cwd);
  const directory = artifactDirectoryForTurn(cwd, turnId, ownershipToken);
  mkdirSync(directory, { mode: 0o700 });
  assertRealDirectory(root, "Artifact root");
  assertRealDirectory(directory, "Turn artifact directory");
  return directory;
}

export function validateArtifactDirectory(directory: string) {
  assertRealDirectory(directory, "Turn artifact directory");
}

export function cleanupArtifactDirectoryIfEmpty(directory: string) {
  try {
    rmdirSync(directory);
    return true;
  } catch (error: any) {
    if (error?.code === "ENOENT" || error?.code === "ENOTEMPTY" || error?.code === "EEXIST") return false;
    throw error;
  }
}

export function findTurnArtifacts(directory: string): ArtifactFile[] {
  validateArtifactDirectory(directory);
  const entries = readdirSync(directory, { withFileTypes: true });
  const artifacts: ArtifactFile[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Refusing symbolic-link artifact ${path}. Copy the regular file into the turn directory.`);
    }
    if (!entry.isFile()) continue;
    artifacts.push(inspectOpenedArtifact(path, entry.name));
  }
  return artifacts.sort((a, b) => a.mtimeMs - b.mtimeMs || a.filename.localeCompare(b.filename));
}

export function openVerifiedArtifactStream(artifact: ArtifactFile) {
  const fd = openSync(artifact.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!openedArtifactMatches(fd, artifact)) {
      throw new Error(`Artifact changed after delivery intent was recorded: ${artifact.path}`);
    }
    return createReadStream(artifact.path, { fd, autoClose: true });
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

export function removeDeliveredArtifact(artifact: ArtifactFile) {
  let fd;
  try {
    fd = openSync(artifact.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error: any) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  try {
    if (!openedArtifactMatches(fd, artifact)) {
      throw new Error(`Refusing to remove a changed artifact staging path: ${artifact.path}`);
    }
    const pathStat = lstatSync(artifact.path);
    const openedStat = fstatSync(fd);
    if (!pathStat.isFile()
      || String(pathStat.dev) !== String(openedStat.dev)
      || String(pathStat.ino) !== String(openedStat.ino)) {
      throw new Error(`Refusing to remove a replaced artifact staging path: ${artifact.path}`);
    }
    unlinkSync(artifact.path);
  } finally {
    closeSync(fd);
  }
  return true;
}

export function removeArtifactStagingTree(directory: string) {
  try {
    validateArtifactDirectory(directory);
  } catch (error: any) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  const removeEntries = (currentDirectory: string) => {
    for (const entry of readdirSync(currentDirectory, { withFileTypes: true })) {
      const path = join(currentDirectory, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        assertRealDirectory(path, "Nested artifact staging directory");
        removeEntries(path);
        rmdirSync(path);
        continue;
      }
      unlinkSync(path);
    }
  };
  removeEntries(directory);
  rmdirSync(directory);
  return true;
}

export function buildArtifactPromptContext(directory: string) {
  return [
    "Slack artifact delivery for this turn:",
    `- To attach a generated file to this Slack thread, copy a regular-file staging copy directly into ${JSON.stringify(directory)}.`,
    "- Keep the canonical project file outside .artifacts; confirmed staging copies are deleted after upload.",
    "- Concierge uploads only direct regular files from this exact turn-owned directory. Symbolic links are rejected.",
    "- Do not write artifacts to the shared .artifacts root or to another turn's directory; those files will not be uploaded.",
  ].join("\n");
}
