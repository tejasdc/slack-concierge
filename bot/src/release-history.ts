import { db } from "./state";

/**
 * Concierge's own releases, as proven live by the deployment pipeline, for surfaces that
 * list what reached the running service. A release counts once it was promoted after its
 * health proof; the last-known-good release is the one running now. Titles and changes
 * come from this service's own repository, so a surface never reads it directly.
 */
export type ReleaseView = {
  revision: string;
  activatedAt: string | null;
  current: boolean;
  title: string | null;
  changes: { revision: string; title: string }[];
};

const LIMIT = 50;
const commitTitles = new Map<string, string | null>();
const rangeChanges = new Map<string, { revision: string; title: string }[]>();

function repositoryRoot() {
  return process.env.CONCIERGE_REPOSITORY_ROOT || "/root/workspace/slack-concierge";
}

function git(arguments_: string[]): string | null {
  const result = Bun.spawnSync({
    cmd: ["git", ...arguments_],
    cwd: repositoryRoot(),
    env: { ...process.env, HOME: process.env.HOME || "/root", GIT_TERMINAL_PROMPT: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  return result.exitCode === 0 ? Buffer.from(result.stdout).toString("utf8") : null;
}

// Commits are immutable, so a title or a range, once read, never needs reading again.
function commitTitle(revision: string) {
  if (!commitTitles.has(revision)) commitTitles.set(revision, git(["log", "-1", "--format=%s", revision])?.trim() || null);
  return commitTitles.get(revision)!;
}

function changesBetween(previous: string | null, revision: string) {
  const key = `${previous ?? ""}..${revision}`;
  if (!rangeChanges.has(key)) {
    const output = previous ? git(["log", "--first-parent", "--reverse", "--format=%H%x09%s", `${previous}..${revision}`]) : null;
    rangeChanges.set(key, (output ?? "").split("\n").filter(Boolean).map((line) => {
      const [hash, ...subject] = line.split("\t");
      return { revision: hash!, title: subject.join("\t") };
    }));
  }
  return rangeChanges.get(key)!;
}

/**
 * What a pending update brings him, in his own language. Commit subjects are written for
 * agents, so they are never shown: a change says what changes for him in an `Update-note:`
 * line, or in a note on `refs/notes/update` when the commit is already pushed (that note
 * wins, so it can correct one — including replacing a retired `internal` marker).
 */
// Never remembered: a note can be attached, or corrected, while its update waits, and the
// notice is read again every minute, so the next read must see it.
function updateNote(revision: string) {
  const attached = git(["notes", "--ref=refs/notes/update", "show", revision])?.trim();
  const written = attached || noteInMessage(git(["log", "-1", "--format=%B", revision]) ?? "");
  return written ? written.replace(/\s+/g, " ").trim() : null;
}

/**
 * The note is read from anywhere in the message, because a blank line before other trailers
 * hides it from git's own trailer parser — and it is read whole. An editor wraps a sentence
 * at the commit-message margin, so reading only the first line published half a sentence to
 * him ("...was showing no usage at all for either"), three times in one evening.
 */
function noteInMessage(message: string) {
  const lines = message.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const opening = /^Update-note:\s*(.+)$/i.exec(lines[index]!.trim())?.[1];
    if (!opening) continue;
    const sentence = [opening];
    // The note ends where the paragraph does: a blank line, or the next trailer.
    for (let next = index + 1; next < lines.length; next++) {
      const line = lines[next]!.trim();
      if (!line || /^[A-Za-z][\w-]*:\s/.test(line)) break;
      sentence.push(line);
    }
    return sentence.join(" ");
  }
  return null;
}

/**
 * What a pending update holds: the sentence written for each of its changes, and how many have
 * none. **Every change gets one, including work he cannot see on a screen.** The old `internal`
 * marker is retired and counts here as no description at all, because he threw it out
 * (2026-09-23): "I'm not asking for updates only in the visual aspects of it. I need to
 * understand, look, what the back end is going … every single thing that is, we are changing,
 * every update is gonna matter, right? … Yes, maybe I don't visibly see, but who cares?"
 */
export function pendingUpdateSummary(previous: string | null, revision: string): {
  notes: string[];
  undescribed: number;
} {
  if (!previous || previous === revision) return { notes: [], undescribed: 0 };
  const notes: string[] = [];
  let undescribed = 0;
  for (const change of changesBetween(previous, revision)) {
    const note = updateNote(change.revision);
    // `internal` was never a description: those changes are waiting for their sentence like any
    // other, and a git note on the commit is how one is added after the fact.
    if (!note || /^internal\.?$/i.test(note)) { undescribed += 1; continue; }
    if (!notes.includes(note)) notes.push(note);
  }
  return { notes, undescribed };
}

/** The notes for every change between the running release and a pending one, in order. */
export function pendingUpdateNotes(previous: string | null, revision: string): string[] {
  return pendingUpdateSummary(previous, revision).notes;
}

/**
 * Whether main still has the commit a push asked for. A force-push leaves that commit on no branch
 * at all, and nothing can ever install it: every deployment installs main and ends with the desired
 * commit still unmet, so the next one starts at once. Nine deployments ran in eleven minutes that
 * way on 2026-09-23, each restarting the service and draining his sessions, and his update notice
 * never cleared (capture d526a570). The fetch happens only in the case that already looks wrong,
 * because a commit can also be missing here simply because this checkout has not fetched it yet.
 */
export function commitMainHas(commit: string): { head: string; rewritten: boolean } | null {
  const head = () => git(["rev-parse", "origin/main"])?.trim() || null;
  const contains = () => git(["merge-base", "--is-ancestor", commit, "origin/main"]) !== null;
  const answer = (rewritten: boolean) => { const at = head(); return at ? { head: at, rewritten } : null; };
  if (contains()) return answer(false);
  git(["fetch", "origin", "--quiet"]);
  return contains() ? answer(false) : answer(true);
}

const iso = (value: string | null) => value ? new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`).toISOString() : null;

export function releaseHistory(): { releases: ReleaseView[] } {
  const rows = db.query(`SELECT git_commit, state, activated_at FROM deployment_releases
    WHERE promoted_at IS NOT NULL ORDER BY promoted_at DESC, rowid DESC LIMIT ?`).all(LIMIT + 1) as
    { git_commit: string; state: string; activated_at: string | null }[];
  return {
    releases: rows.slice(0, LIMIT).map((row, index) => ({
      revision: row.git_commit,
      activatedAt: iso(row.activated_at),
      current: row.state === "lkg",
      title: commitTitle(row.git_commit),
      changes: changesBetween(rows[index + 1]?.git_commit ?? null, row.git_commit),
    })),
  };
}
