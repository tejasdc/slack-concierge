/**
 * No Claude agent sits blind on a build. On 2026-11-01 at 10:28 PM ET the canvas voice repair Tejas
 * was waiting on ran thnkr.ing's build in the foreground: it queued 366 s for one of the host's
 * shared build slots behind seven other sessions, built for 4.6 minutes, and the agent could neither
 * act nor read his new message until its 10-minute tool limit (his words: "Why are the agents waiting
 * for the build to happen? … agents waiting on it is a bigger problem"). Claude Code can run any
 * command in the background and wakes the agent when it ends, so a command that waits on a shared
 * build slot is refused in the foreground and the agent is told to run it with run_in_background.
 *
 * What counts as such a command is read from the code, not from a list kept here: a `node`/`bun`
 * script, or an `npm run`/`node --run` package script, whose source (or a relative module it imports,
 * a few levels deep) names the slot entrance — thnkr.ing's `host-build-slot.mjs` or
 * `run-in-build-slot.mjs` — or carries the marker `agents-run-this-in-background`. A project adds a
 * long command by naming that marker in its source. Codex is not refused: its command tool already
 * hands control back after a short yield, so a slow command never freezes the agent.
 *
 * It only ever asks for the same command to be run another way; anything it cannot read lets the
 * command through.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

const SLOT_MARK = /host-build-slot\.mjs|run-in-build-slot\.mjs|agents-run-this-in-background/;
const SCRIPT = /(?:^|[\s;&|(])(?:[^\s"';|&()]*\/)?(?:node|bun)\s+(?:run\s+)?(?:--?[\w-]+(?:=\S+)?\s+)*["']?([^\s"';|&()]+\.[cm]?[jt]s)(?=$|[\s"';|&)])/g;
const PACKAGE_SCRIPT = /(?:^|[\s;&|(])(?:npm\s+(?:run(?:-script)?|run)|pnpm(?:\s+run)?|node\s+--run|bun\s+run)\s+([\w:.-]+)/g;
const CD = /(?:^|[;&|(]\s*)cd\s+["']?([^\s"';|&()]+)/g;
const IMPORT = /(?:from\s+|import\s*\(\s*|import\s+)["'](\.{1,2}\/[^"']+)["']|["'`](?:\.\/)?(scripts\/[\w./-]+\.[cm]?js)["'`]/g;

function text(path: string): string | null {
  try { return statSync(path).isFile() && statSync(path).size < 2_000_000 ? readFileSync(path, 'utf8') : null; } catch { return null; }
}

function takesSlot(entry: string, root: string): boolean {
  const seen = new Set<string>();
  let frontier = [entry];
  for (let depth = 0; depth < 4 && frontier.length; depth++) {
    const next: string[] = [];
    for (const file of frontier) {
      if (seen.has(file) || seen.size > 60) continue;
      seen.add(file);
      const source = text(file);
      if (source === null) continue;
      if (SLOT_MARK.test(source)) return true;
      for (const match of source.matchAll(IMPORT)) {
        const target = match[1] ? resolve(dirname(file), match[1]) : resolve(root, match[2]!);
        if (/\.[cm]?js$/.test(target)) next.push(target);
      }
    }
    frontier = next;
  }
  return false;
}

/** The project root a relative script resolves against: the nearest folder with a package.json. */
function projectRoot(from: string): string {
  for (let dir = from; ; dir = dirname(dir)) {
    if (existsSync(resolve(dir, 'package.json'))) return dir;
    if (dirname(dir) === dir) return from;
  }
}

/** What the shell runs: heredoc bodies and quoted words (a commit message, a reply) are text, not commands. */
function executed(command: string): string {
  return command
    .replace(/(<<-?\s*['"]?(\w+)['"]?[^\n]*)\n[\s\S]*?\n\s*\2(?=\s|$)/g, '$1')
    .replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "''");
}

export function foregroundBuildRefusal(source: string, input: Record<string, unknown>, cwd: string): string | null {
  if (input.run_in_background === true) return null;
  const command = executed(source);
  const dirs = [cwd, ...[...command.matchAll(CD)].map(match => isAbsolute(match[1]!) ? match[1]! : resolve(cwd, match[1]!))];
  const found: string[] = [];
  for (const match of command.matchAll(SCRIPT)) {
    for (const dir of dirs) {
      const file = isAbsolute(match[1]!) ? match[1]! : resolve(dir, match[1]!);
      if (existsSync(file) && takesSlot(file, projectRoot(dirname(file)))) { found.push(match[1]!); break; }
    }
  }
  for (const match of command.matchAll(PACKAGE_SCRIPT)) {
    for (const dir of dirs) {
      const root = projectRoot(dir);
      let script: unknown;
      try { script = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).scripts?.[match[1]!]; } catch { continue; }
      if (typeof script !== 'string') continue;
      if ([...script.matchAll(SCRIPT)].some(inner => takesSlot(resolve(root, inner[1]!), root))) { found.push(`npm run ${match[1]}`); break; }
    }
  }
  if (!found.length) return null;
  return `Refused in the foreground: ${found.join(', ')} waits for a shared host build slot and can take many minutes, and while it runs you cannot act or read new messages. Run the same command again with run_in_background: true; you are woken when it ends, and can keep working or end your turn meanwhile.`;
}
