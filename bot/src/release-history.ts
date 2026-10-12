import { db } from "./state";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

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
type Change = { revision: string; title: string; note: string | null; merge: boolean };

function repositoryRoot() {
  return process.env.CONCIERGE_REPOSITORY_ROOT || "/var/lib/slack-concierge-deployment/source";
}

async function git(arguments_: string[]): Promise<string | null> {
  try {
    const result = await promisify(execFile)("git", arguments_, { cwd: repositoryRoot(),
      env: { ...process.env, HOME: process.env.HOME || "/root", GIT_TERMINAL_PROMPT: "0" }, maxBuffer: 16 * 1024 * 1024 });
    return result.stdout;
  } catch { return null; }
}

async function changesBetween(previous: string | null, revision: string): Promise<Change[]> {
  // The oldest listed release still needs a description. Its first parent is the boundary
  // when the previous release has fallen out of the bounded history.
  const base = previous || (await git(["rev-parse", `${revision}^1`]))?.trim() || null;
  const range = base ? [`${base}..${revision}`] : ["--max-count=1", revision];
  // Include branch commits inside a merge. Notes are read on every request because an
  // already-published note may be corrected without changing the commit or release row.
  const output = await git(["log", "--notes=refs/notes/update", "--topo-order", "--reverse",
    "--format=%x1e%H%x00%P%x00%s%x00%B%x00%N", ...range]);
  return (output ?? "").split("\x1e").slice(1).map((record) => {
    const [hash, parents, subject, body, attached] = record.split("\x00");
    const written = attached?.trim() || noteInMessage(body ?? "");
    return {
      revision: hash?.trim() ?? "",
      title: subject ?? "",
      note: written && !/^internal\.?$/i.test(written) ? written.replace(/\s+/g, " ").trim() : null,
      merge: (parents?.trim().split(/\s+/).length ?? 0) > 1,
    };
  }).filter((change) => change.revision);
}

/**
 * What a pending update brings him, in his own language. Commit subjects are written for
 * agents, so they are never shown: a change says what changes for him in an `Update-note:`
 * line, or in a note on `refs/notes/update` when the commit is already pushed (that note
 * wins, so it can correct one — including replacing a retired `internal` marker).
 */
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
 * What a pending update holds: the sentences written for its changes, and the commit subjects
 * for changes that have none. **Every change gets one, including work he cannot see on a screen.** The old `internal`
 * marker is retired and counts here as no description at all, because he threw it out
 * (2026-09-23): "I'm not asking for updates only in the visual aspects of it. I need to
 * understand, look, what the back end is going … every single thing that is, we are changing,
 * every update is gonna matter, right? … Yes, maybe I don't visibly see, but who cares?"
 */
// A sentence is often written after its commit is pushed, as a note on `refs/notes/update`, and
// this checkout fetched only branches: on 2026-10-08 a change with a note showed him its developer
// subject instead. A summary missing a sentence fetches the notes in the background, at most every
// few minutes, so the next read has them without the owner waiting on the network.
const NOTES_REFRESH_MS = 3 * 60_000;
let notesRefreshedAt = 0;
function refreshNotesSoon() {
  if (Date.now() - notesRefreshedAt < NOTES_REFRESH_MS) return;
  notesRefreshedAt = Date.now();
  try {
    Bun.spawn({ cmd: ["git", "fetch", "--quiet", "origin", "+refs/notes/update:refs/notes/update"], cwd: repositoryRoot(),
      env: { ...process.env, HOME: process.env.HOME || "/root", GIT_TERMINAL_PROMPT: "0" }, stdout: "ignore", stderr: "ignore" });
  } catch { /* The next read tries again after the interval. */ }
}

export async function pendingUpdateSummary(previous: string | null, revision: string): Promise<{
  notes: string[];
  subjects: string[];
}> {
  if (!previous || previous === revision) return { notes: [], subjects: [] };
  const notes: string[] = [];
  const subjects: string[] = [];
  for (const change of await changesBetween(previous, revision)) {
    const note = change.note;
    // `internal` was never a description: those changes are waiting for their sentence like any
    // other, and a git note on the commit is how one is added after the fact.
    if (!note || /^internal\.?$/i.test(note)) {
      refreshNotesSoon();
      // A merge is a delivery wrapper, not a change. Its branch commits are already here.
      if (!change.merge && !subjects.includes(change.title)) subjects.push(change.title);
      continue;
    }
    if (!notes.includes(note)) notes.push(note);
  }
  return { notes, subjects };
}

/** The notes for every change between the running release and a pending one, in order. */
export async function pendingUpdateNotes(previous: string | null, revision: string): Promise<string[]> {
  return (await pendingUpdateSummary(previous, revision)).notes;
}

/**
 * Whether main still has the commit a push asked for. A force-push leaves that commit on no branch
 * at all, and nothing can ever install it: every deployment installs main and ends with the desired
 * commit still unmet, so the next one starts at once. Nine deployments ran in eleven minutes that
 * way on 2026-09-23, each restarting the service and draining his sessions, and his update notice
 * never cleared (capture d526a570). The fetch happens only in the case that already looks wrong,
 * because a commit can also be missing here simply because this checkout has not fetched it yet.
 */
export async function commitMainHas(commit: string): Promise<{ head: string; rewritten: boolean } | null> {
  const head = async () => (await git(["rev-parse", "origin/main"]))?.trim() || null;
  const contains = async () => await git(["merge-base", "--is-ancestor", commit, "origin/main"]) !== null;
  const answer = async (rewritten: boolean) => { const at = await head(); return at ? { head: at, rewritten } : null; };
  if (await contains()) return answer(false);
  await git(["fetch", "origin", "--quiet"]);
  return await contains() ? answer(false) : answer(true);
}

const iso = (value: string | null) => value ? new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`).toISOString() : null;

export async function releaseHistory(): Promise<{ releases: ReleaseView[] }> {
  const rows = db.query(`SELECT git_commit, state, activated_at FROM deployment_releases
    WHERE promoted_at IS NOT NULL ORDER BY promoted_at DESC, rowid DESC LIMIT ?`).all(LIMIT + 1) as
    { git_commit: string; state: string; activated_at: string | null }[];
  const releases: ReleaseView[] = [];
  for (const [index, row] of rows.slice(0, LIMIT).entries()) {
    const rawChanges = await changesBetween(rows[index + 1]?.git_commit ?? null, row.git_commit);
    if (rawChanges.some((change) => !change.note)) refreshNotesSoon();
    const changes = rawChanges
      .filter((change) => !change.merge || change.note)
      .map((change) => ({ revision: change.revision, title: change.note ?? change.title }));
    releases.push({
      revision: row.git_commit,
      activatedAt: iso(row.activated_at),
      current: row.state === "lkg",
      title: changes.length === 1 ? changes[0]!.title : changes.length > 1
        ? `${changes.length} changes published` : "An agent service update was published",
      changes,
    });
  }
  return { releases };
}
