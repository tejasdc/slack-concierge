import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";

export type ProjectCutoverPhase = "blocked" | "propagating" | "canvas_required";

export interface ProjectPropagationIntent {
  projectName: string;
  codePath: string;
  vaultPath: string;
  canonicalCodePath: string;
  canonicalVaultPath: string;
  branch: string;
  upstream: string;
  preparedHead: string;
  plannedActions: string[];
  expectedGitFingerprint: string;
  propagatedHead: string | null;
}

export interface ProjectCutoverState {
  version: 1;
  phase: ProjectCutoverPhase;
  startedAt: string;
  workspaceRoot: string;
  stateDbPath: string;
  captureStateDbPath: string;
  projects: ProjectPropagationIntent[];
}

const CUTOVER_STATE_NAME = "project-scaffold-cutover.json";

export function projectCutoverStatePath(stateDir: string) {
  return join(stateDir, CUTOVER_STATE_NAME);
}

export function readProjectCutoverState(stateDir: string): ProjectCutoverState | null {
  const path = projectCutoverStatePath(stateDir);
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  validateState(parsed);
  return parsed;
}

export function beginProjectCutover(input: {
  stateDir: string;
  workspaceRoot: string;
  stateDbPath: string;
  captureStateDbPath: string;
}) {
  const existing = readProjectCutoverState(input.stateDir);
  if (existing) {
    if (
      existing.workspaceRoot !== input.workspaceRoot
      || existing.stateDbPath !== input.stateDbPath
      || existing.captureStateDbPath !== input.captureStateDbPath
    ) {
      throw new Error("Existing project scaffold cutover belongs to a different workspace or registry");
    }
    return existing;
  }
  const state: ProjectCutoverState = {
    version: 1,
    phase: "blocked",
    startedAt: new Date().toISOString(),
    workspaceRoot: input.workspaceRoot,
    stateDbPath: input.stateDbPath,
    captureStateDbPath: input.captureStateDbPath,
    projects: [],
  };
  writeProjectCutoverState(input.stateDir, state);
  return state;
}

export function persistPropagationIntent(
  stateDir: string,
  projects: ProjectPropagationIntent[],
) {
  const state = requiredState(stateDir);
  if (state.phase === "canvas_required") {
    throw new Error("Cannot replace propagation intent after Canvas cutover began");
  }
  if (state.projects.length > 0 && JSON.stringify(state.projects) !== JSON.stringify(projects)) {
    throw new Error("Existing project propagation intent does not match the prepared inventory");
  }
  const updated = { ...state, phase: "propagating" as const, projects };
  writeProjectCutoverState(stateDir, updated);
  return updated;
}

export function markProjectPropagated(stateDir: string, codePath: string, propagatedHead: string) {
  const state = requiredState(stateDir);
  const index = state.projects.findIndex((project) => project.codePath === codePath);
  if (index < 0) throw new Error(`Project is absent from propagation intent: ${codePath}`);
  const projects = state.projects.map((project, projectIndex) => projectIndex === index
    ? { ...project, propagatedHead }
    : project);
  writeProjectCutoverState(stateDir, { ...state, projects });
}

export function requireCanvasRefresh(stateDir: string) {
  const state = requiredState(stateDir);
  if (state.projects.some((project) => project.propagatedHead === null)) {
    throw new Error("Cannot require Canvas refresh before every propagation target is complete");
  }
  writeProjectCutoverState(stateDir, { ...state, phase: "canvas_required" });
}

export function completeProjectCutover(stateDir: string) {
  const state = requiredState(stateDir);
  if (state.phase !== "canvas_required") {
    throw new Error(`Cannot complete project scaffold cutover from phase ${state.phase}`);
  }
  const database = new Database(state.stateDbPath, { readonly: true, strict: true });
  try {
    if (database.query("SELECT 1 FROM deployment_drain WHERE singleton=1").get()) {
      throw new Error("Cannot complete project scaffold cutover while the deployment gate exists");
    }
  } finally {
    database.close();
  }
  const captureDatabase = new Database(state.captureStateDbPath, { readonly: true, strict: true });
  try {
    if (captureDatabase.query("SELECT 1 FROM capture_delivery_gate WHERE singleton=1").get()) {
      throw new Error("Cannot complete project scaffold cutover while the capture delivery gate exists");
    }
  } finally {
    captureDatabase.close();
  }
  unlinkSync(projectCutoverStatePath(stateDir));
  fsyncDirectory(stateDir);
}

export function startupCutoverDecision(stateDir: string) {
  const state = readProjectCutoverState(stateDir);
  if (!state) return { allowStartup: true, preserveDrain: false, requireCanvasRefresh: false };
  if (state.phase !== "canvas_required") {
    return { allowStartup: false, preserveDrain: true, requireCanvasRefresh: false };
  }
  return { allowStartup: true, preserveDrain: true, requireCanvasRefresh: true };
}

function requiredState(stateDir: string) {
  const state = readProjectCutoverState(stateDir);
  if (!state) throw new Error("Project scaffold cutover state is missing");
  return state;
}

function writeProjectCutoverState(stateDir: string, state: ProjectCutoverState) {
  validateState(state);
  mkdirSync(stateDir, { recursive: true });
  const path = projectCutoverStatePath(stateDir);
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  const descriptor = openSync(temporaryPath, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporaryPath, path);
  fsyncDirectory(dirname(path));
}

function fsyncDirectory(path: string) {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function validateState(value: unknown): asserts value is ProjectCutoverState {
  const state = value as Partial<ProjectCutoverState> | null;
  if (
    !state
    || state.version !== 1
    || !["blocked", "propagating", "canvas_required"].includes(String(state.phase))
    || typeof state.startedAt !== "string"
    || typeof state.workspaceRoot !== "string"
    || typeof state.stateDbPath !== "string"
    || typeof state.captureStateDbPath !== "string"
    || !Array.isArray(state.projects)
  ) {
    throw new Error("Project scaffold cutover state is malformed");
  }
  for (const project of state.projects) {
    if (
      !project
      || typeof project.projectName !== "string"
      || typeof project.codePath !== "string"
      || typeof project.vaultPath !== "string"
      || typeof project.canonicalCodePath !== "string"
      || typeof project.canonicalVaultPath !== "string"
      || typeof project.branch !== "string"
      || typeof project.upstream !== "string"
      || typeof project.preparedHead !== "string"
      || !Array.isArray(project.plannedActions)
      || project.plannedActions.some((action) => typeof action !== "string")
      || typeof project.expectedGitFingerprint !== "string"
      || (project.propagatedHead !== null && typeof project.propagatedHead !== "string")
    ) {
      throw new Error("Project scaffold propagation intent is malformed");
    }
  }
}
