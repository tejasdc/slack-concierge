import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function codexDaemonSettingsPath(home = homedir()): string {
  return join(home, ".codex", "app-server-daemon", "settings.json");
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readSettings(path: string): Record<string, unknown> | null {
  let bytes: string;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()) throw new Error("Codex daemon settings are not a regular file.");
    bytes = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const parsed: unknown = JSON.parse(bytes);
    if (record(parsed)) return parsed;
  } catch { /* Refuse malformed private settings without echoing their contents. */ }
  throw new Error("Codex daemon settings are malformed; refusing to replace them.");
}

export function codexUpdaterDisabled(path = codexDaemonSettingsPath()): boolean {
  try {
    const settings = readSettings(path);
    return !!settings && record(settings.updater) && settings.updater.autoUpdateEnabled === false;
  } catch { return false; }
}

/** Preserve Codex's other settings; a malformed file is never overwritten. */
export function ensureCodexUpdaterDisabled(path = codexDaemonSettingsPath()): "changed" | "unchanged" {
  const settings = readSettings(path) ?? {};
  if (settings.updater !== undefined && !record(settings.updater)) {
    throw new Error("Codex daemon updater settings are malformed; refusing to replace them.");
  }
  if (record(settings.updater) && settings.updater.autoUpdateEnabled === false) return "unchanged";
  const updated = { ...settings, updater: { ...(record(settings.updater) ? settings.updater : {}), autoUpdateEnabled: false } };
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.settings.json.${process.pid}.${randomUUID()}.tmp`);
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(updated, null, 2)}\n`);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporary, path);
  } catch (error) {
    if (descriptor !== null) closeSync(descriptor);
    try { unlinkSync(temporary); } catch { /* The original settings remain untouched. */ }
    throw error;
  }
  if (!codexUpdaterDisabled(path)) throw new Error("Codex updater setting did not persist.");
  return "changed";
}
