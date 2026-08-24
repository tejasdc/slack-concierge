import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { posix, relative, resolve, sep } from "node:path";

export interface RepairPolicy {
  version: number;
  target: string;
  autonomous: {
    existing_source: string[];
    source_prefixes: string[];
    tests: string[];
    test_prefixes: string[];
    required_docs: string[];
  };
  protected: {
    exact: string[];
    prefixes: string[];
  };
  limits: {
    maximum_changed_files: number;
    maximum_patch_bytes: number;
    require_focused_test: boolean;
    require_current_state_documentation: boolean;
    require_independent_ship: boolean;
    require_unchanged_origin_base: boolean;
  };
}

export interface PolicyEvaluation {
  accepted: boolean;
  normalizedPaths: string[];
  sourcePaths: string[];
  testPaths: string[];
  documentationPaths: string[];
  rejected: Array<{ path: string; reason: string }>;
}

function sha256(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizedPolicyPath(path: string) {
  if (!path || path.includes("\0") || path.includes("\\")) throw new Error(`Invalid policy path ${JSON.stringify(path)}.`);
  const normalized = posix.normalize(path);
  if (normalized === "." || normalized.startsWith("../") || normalized.startsWith("/") || normalized.includes("/../")) {
    throw new Error(`Policy path escapes the repository: ${path}.`);
  }
  return normalized;
}

function normalizePolicy(policy: RepairPolicy): RepairPolicy {
  const lists = [
    policy.autonomous.existing_source,
    policy.autonomous.source_prefixes,
    policy.autonomous.tests,
    policy.autonomous.test_prefixes,
    policy.autonomous.required_docs,
    policy.protected.exact,
    policy.protected.prefixes,
  ];
  for (const values of lists) {
    if (!Array.isArray(values)) throw new Error("Deployment repair policy path lists are required.");
    for (let index = 0; index < values.length; index += 1) values[index] = normalizedPolicyPath(String(values[index]));
  }
  if (!Number.isSafeInteger(policy.version) || policy.version <= 0) throw new Error("Policy version must be a positive integer.");
  if (!Number.isSafeInteger(policy.limits.maximum_changed_files) || policy.limits.maximum_changed_files <= 0) {
    throw new Error("maximum_changed_files must be a positive integer.");
  }
  if (!Number.isSafeInteger(policy.limits.maximum_patch_bytes) || policy.limits.maximum_patch_bytes <= 0) {
    throw new Error("maximum_patch_bytes must be a positive integer.");
  }
  return policy;
}

export function loadRepairPolicy(path: string): { policy: RepairPolicy; digest: string } {
  const source = readFileSync(path, "utf8");
  const parsed = Bun.TOML.parse(source) as unknown as RepairPolicy;
  return { policy: normalizePolicy(parsed), digest: sha256(source) };
}

function matches(path: string, exact: string[], prefixes: string[]) {
  return exact.includes(path) || prefixes.some((prefix) => path.startsWith(prefix));
}

export function evaluateRepairDiff(
  policy: RepairPolicy,
  changedPaths: string[],
  patchBytes: number,
): PolicyEvaluation {
  const normalizedPaths = [...new Set(changedPaths.map(normalizedPolicyPath))].sort();
  const rejected: Array<{ path: string; reason: string }> = [];
  const sourcePaths: string[] = [];
  const testPaths: string[] = [];
  const documentationPaths: string[] = [];

  if (normalizedPaths.length > policy.limits.maximum_changed_files) {
    rejected.push({ path: "*", reason: `changed file count exceeds ${policy.limits.maximum_changed_files}` });
  }
  if (!Number.isSafeInteger(patchBytes) || patchBytes < 0 || patchBytes > policy.limits.maximum_patch_bytes) {
    rejected.push({ path: "*", reason: `patch size exceeds ${policy.limits.maximum_patch_bytes} bytes` });
  }

  for (const path of normalizedPaths) {
    if (matches(path, policy.protected.exact, policy.protected.prefixes)) {
      rejected.push({ path, reason: "path is protected authority" });
      continue;
    }
    if (matches(path, policy.autonomous.existing_source, policy.autonomous.source_prefixes)) {
      sourcePaths.push(path);
      continue;
    }
    if (matches(path, policy.autonomous.tests, policy.autonomous.test_prefixes)) {
      testPaths.push(path);
      continue;
    }
    if (policy.autonomous.required_docs.includes(path)) {
      documentationPaths.push(path);
      continue;
    }
    rejected.push({ path, reason: "path is outside the autonomous repair surface" });
  }

  if (sourcePaths.length > 0 && policy.limits.require_focused_test && testPaths.length === 0) {
    rejected.push({ path: "*", reason: "source changes require an allowed focused test" });
  }
  if (sourcePaths.length > 0
    && policy.limits.require_current_state_documentation
    && documentationPaths.length === 0) {
    rejected.push({ path: "*", reason: "source changes require current-state deployment documentation" });
  }

  return {
    accepted: rejected.length === 0,
    normalizedPaths,
    sourcePaths,
    testPaths,
    documentationPaths,
    rejected,
  };
}

function walkRegularFiles(root: string, directory = root): string[] {
  const entries = readdirSync(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`Protected kernel tree contains symlink ${path}.`);
    if (stat.isDirectory()) {
      files.push(...walkRegularFiles(root, path));
      continue;
    }
    if (!stat.isFile()) throw new Error(`Protected kernel tree contains special file ${path}.`);
    files.push(relative(root, path).split(sep).join("/"));
  }
  return files.sort();
}

export function digestProtectedKernel(root: string) {
  const canonicalRoot = realpathSync(root);
  const hash = createHash("sha256");
  for (const path of walkRegularFiles(canonicalRoot)) {
    const contents = readFileSync(resolve(canonicalRoot, path));
    hash.update(`${path}\0${contents.byteLength}\0`);
    hash.update(contents);
    hash.update("\0");
  }
  return hash.digest("hex");
}
