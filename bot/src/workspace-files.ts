import { readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { sessionProjects } from './session-projects';

/** Refusals carry the status and code the owner surfaces; this module stays independent of it. */
export class WorkspaceFileError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) { super(message); }
}

/**
 * Agents write files into the checkouts under this machine's workspace root, then name one
 * in a message. This reads that file back so a surface can show it, and says which of three
 * kinds it is so the surface does not guess: prose (`markdown`), a self-contained page
 * (`page`), or anything else readable as text.
 *
 * The boundary is deliberately narrow and stated in the refusals below: a known readable
 * kind, never a dotfile, under the workspace root only, after symlinks are resolved. A
 * `page` carries scripts, so the surface showing it owns that containment; this only says
 * what the file is. Nothing here writes, lists a directory, or accepts a path a model
 * composed on a caller's behalf — a human surface passes the path it displayed.
 */
export type WorkspaceFileKind = 'markdown' | 'page' | 'text';
export type WorkspaceFile = {
  machine: string;
  path: string;
  name: string;
  project: string | null;
  relativePath: string;
  kind: WorkspaceFileKind;
  size: number;
  modifiedAt: string;
  content: string;
};

/**
 * Every kind here is delivered as text. A page's own scripts run only where a surface
 * decides to run them; nothing is added for that here.
 */
export const VIEWABLE_EXTENSIONS: Readonly<Record<string, WorkspaceFileKind>> = {
  '.md': 'markdown', '.markdown': 'markdown', '.mdx': 'markdown',
  '.html': 'page', '.htm': 'page',
  '.txt': 'text', '.text': 'text', '.log': 'text', '.csv': 'text', '.tsv': 'text',
  '.json': 'text', '.jsonl': 'text', '.ndjson': 'text', '.yaml': 'text', '.yml': 'text',
  '.toml': 'text', '.ini': 'text', '.cfg': 'text', '.xml': 'text', '.svg': 'text',
  '.css': 'text', '.scss': 'text', '.js': 'text', '.mjs': 'text', '.cjs': 'text',
  '.jsx': 'text', '.ts': 'text', '.tsx': 'text', '.py': 'text', '.rb': 'text',
  '.go': 'text', '.rs': 'text', '.swift': 'text', '.java': 'text', '.kt': 'text',
  '.c': 'text', '.h': 'text', '.cc': 'text', '.cpp': 'text', '.sh': 'text',
  '.bash': 'text', '.zsh': 'text', '.sql': 'text', '.graphql': 'text',
  '.diff': 'text', '.patch': 'text',
};
const MAX_BYTES = 8 * 1024 * 1024;

/** `~` is this machine's home. Every other path is taken as written. */
export function expandHome(path: string): string {
  return path === '~' ? homedir() : path.startsWith('~/') ? resolve(homedir(), path.slice(2)) : path;
}

const within = (root: string, path: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

export function readWorkspaceFile(input: { machine: string; workspaceRoot: string; path: string }): WorkspaceFile {
  const requested = typeof input.path === 'string' ? input.path.trim() : '';
  if (!requested || requested.includes('\0')) throw new WorkspaceFileError('A file path is required.', 400, 'FILE_PATH_INVALID');
  const path = resolve(expandHome(requested));
  if (!isAbsolute(path)) throw new WorkspaceFileError('A file path must be absolute or start with ~.', 400, 'FILE_PATH_INVALID');
  const name = path.split(sep).pop() ?? path;
  // A dotfile is configuration and credentials rather than something an agent asks him to
  // read: `.env` would otherwise arrive as ordinary text.
  const extension = name.toLowerCase().slice(name.toLowerCase().lastIndexOf('.'));
  const kind = name.startsWith('.') ? undefined : VIEWABLE_EXTENSIONS[extension];
  if (!kind) throw new WorkspaceFileError('That kind of file cannot be opened here.', 415, 'FILE_TYPE_UNSUPPORTED');
  let root: string;
  try { root = realpathSync(input.workspaceRoot); } catch { throw new WorkspaceFileError('This machine has no readable workspace root.', 503, 'WORKSPACE_ROOT_UNAVAILABLE'); }
  if (!within(root, path)) throw new WorkspaceFileError(`Only files under ${root} can be opened here.`, 403, 'FILE_OUTSIDE_WORKSPACE');
  let real: string;
  let stats: ReturnType<typeof statSync>;
  try { real = realpathSync(path); stats = statSync(real); }
  catch { throw new WorkspaceFileError('That file is not on this machine.', 404, 'FILE_UNAVAILABLE'); }
  // A symlink out of the workspace is still a read outside it.
  if (!within(root, real)) throw new WorkspaceFileError(`Only files under ${root} can be opened here.`, 403, 'FILE_OUTSIDE_WORKSPACE');
  if (!stats.isFile()) throw new WorkspaceFileError('That path is not a file.', 404, 'FILE_UNAVAILABLE');
  if (stats.size > MAX_BYTES) throw new WorkspaceFileError(`That file is ${Math.round(stats.size / 1024)} KB; this viewer opens files up to ${MAX_BYTES / 1024 / 1024} MB.`, 413, 'FILE_TOO_LARGE');
  const project = sessionProjects(root).find(candidate => within(candidate.cwd, path)) ?? null;
  return {
    machine: input.machine,
    path,
    name,
    kind,
    project: project?.name ?? null,
    relativePath: relative(project?.cwd ?? root, path),
    size: stats.size,
    modifiedAt: new Date(stats.mtimeMs).toISOString(),
    content: readFileSync(real, 'utf8'),
  };
}
