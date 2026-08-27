import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export const DEFAULT_SANDBOX_STATE_ROOT = "/var/lib/slack-concierge-sandbox";

export class SandboxEvidenceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

function safeSlug(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new SandboxEvidenceError("invalid_evidence_identity", `Invalid ${label}`);
  }
  return value;
}

function ensurePrivateDirectory(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()) {
    throw new SandboxEvidenceError("unsafe_evidence_path", `${path} must be an owner-only real directory`);
  }
}

function secretShaped(value: string): boolean {
  return /\b(?:xox[a-z]-|xapp-|xoxe(?:\.|-)|Bearer\s+)[A-Za-z0-9._-]+/i.test(value);
}

function assertEvidenceSafe(value: unknown, path = "evidence"): void {
  if (typeof value === "string") {
    if (secretShaped(value)) throw new SandboxEvidenceError("secret_in_evidence", `${path} contains a Slack credential`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertEvidenceSafe(item, `${path}[${index}]`));
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, item] of Object.entries(value)) {
    if (/(?:token|secret|credential|authorization)/i.test(key)) {
      throw new SandboxEvidenceError("secret_in_evidence", `${path}.${key} is not an allowed evidence field`);
    }
    assertEvidenceSafe(item, `${path}.${key}`);
  }
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function assertPng(path: string): void {
  const bytes = readFileSync(path);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (bytes.length < 24 || !bytes.subarray(0, signature.length).equals(signature)
      || bytes.subarray(12, 16).toString("ascii") !== "IHDR"
      || bytes.readUInt32BE(16) < 1 || bytes.readUInt32BE(20) < 1) {
    throw new SandboxEvidenceError("invalid_browser_evidence", `Browser screenshot is not a rendered PNG: ${path}`);
  }
}

function atomicWrite(path: string, content: string): void {
  ensurePrivateDirectory(dirname(path));
  const temporaryPath = `${path}.${process.pid}.tmp`;
  const descriptor = openSync(temporaryPath, "wx", 0o600);
  try {
    writeFileSync(descriptor, content, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporaryPath, path);
}

export type ScreenshotEvidence = {
  phase: string;
  permalink: string;
  client_workspace_id: string;
  canonical_workspace_domain: string;
  channel_id: string;
  message_ts: string;
  screenshot_path: string;
  screenshot_sha256: string;
  accessibility_path: string;
  geometry_path: string;
};

export class SandboxEvidenceWriter {
  readonly runRoot: string;

  constructor(
    readonly laneId: string,
    readonly runId: string,
    stateRoot = DEFAULT_SANDBOX_STATE_ROOT,
    evidenceRoot?: string,
  ) {
    safeSlug(laneId, "lane ID");
    safeSlug(runId, "run ID");
    const expectedRoot = resolve(stateRoot, "lanes", laneId, "runs", runId, "evidence");
    if (evidenceRoot && resolve(evidenceRoot) !== expectedRoot) {
      throw new SandboxEvidenceError("unsafe_evidence_path", "Evidence root does not belong to the selected sandbox claim");
    }
    this.runRoot = expectedRoot;
    ensurePrivateDirectory(this.runRoot);
  }

  path(...segments: string[]): string {
    const safeSegments = segments.map((segment) => safeSlug(segment, "evidence path segment"));
    const target = resolve(this.runRoot, ...safeSegments);
    const inside = relative(this.runRoot, target);
    if (!inside || inside.startsWith("..") || isAbsolute(inside)) {
      throw new SandboxEvidenceError("unsafe_evidence_path", "Evidence path escaped the run root");
    }
    return target;
  }

  writeJson(name: string, value: unknown): string {
    assertEvidenceSafe(value);
    const path = this.path(name);
    atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
    return path;
  }

  writeJsonIn(directory: string, name: string, value: unknown): string {
    assertEvidenceSafe(value);
    const path = this.path(directory, name);
    atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
    return path;
  }

  ensureDirectory(name: string): string {
    const path = this.path(name);
    ensurePrivateDirectory(path);
    return path;
  }

  verifyScreenshot(input: Omit<ScreenshotEvidence, "screenshot_sha256">): ScreenshotEvidence {
    for (const path of [input.screenshot_path, input.accessibility_path, input.geometry_path]) {
      const absolute = resolve(path);
      const inside = relative(this.runRoot, absolute);
      if (!inside || inside.startsWith("..") || isAbsolute(inside) || !existsSync(absolute)
          || lstatSync(absolute).isSymbolicLink() || !lstatSync(absolute).isFile()) {
        throw new SandboxEvidenceError("invalid_browser_evidence", `Browser evidence is not a regular run-owned file: ${path}`);
      }
    }
    assertPng(input.screenshot_path);
    const evidence = { ...input, screenshot_sha256: sha256File(input.screenshot_path) };
    assertEvidenceSafe(evidence);
    return evidence;
  }
}
