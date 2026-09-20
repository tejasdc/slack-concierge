import { readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { sessionProjects } from './session-projects';

/** Refusals carry the status and code the owner surfaces; this module stays independent of it. */
export class WorkspaceFileError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) { super(message); }
}

/**
 * Agents write Markdown into the checkouts under this machine's workspace root, then name
 * the file in a message. This reads one of those files back so a surface can show it.
 *
 * The boundary is deliberately narrow and stated in the refusals below: Markdown only,
 * under the workspace root only, after symlinks are resolved. Nothing here writes, lists a
 * directory, or accepts a path a model composed on a caller's behalf — a human surface
 * passes the path it displayed.
 */
export type WorkspaceFile = {
  machine: string;
  path: string;
  name: string;
  project: string | null;
  relativePath: string;
  size: number;
  modifiedAt: string;
  content: string;
};

export const MARKDOWN_EXTENSIONS = ['.md', '.markdown', '.mdx'];
const MAX_BYTES = 2 * 1024 * 1024;

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
  if (!MARKDOWN_EXTENSIONS.some(extension => path.toLowerCase().endsWith(extension)))
    throw new WorkspaceFileError('Only Markdown files can be opened here.', 415, 'FILE_TYPE_UNSUPPORTED');
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
    name: path.split(sep).pop() ?? path,
    project: project?.name ?? null,
    relativePath: relative(project?.cwd ?? root, path),
    size: stats.size,
    modifiedAt: new Date(stats.mtimeMs).toISOString(),
    content: readFileSync(real, 'utf8'),
  };
}
