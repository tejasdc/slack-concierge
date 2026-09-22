import { db } from "./state";
import { getTurnCommitProvenance } from "./state";
import { changesMissingUpdateNotes } from "./release-history";
import { retainSessionInput, enqueueSessionInput } from "./session-inputs";
import { log } from "./log";

/**
 * A pending update is described to Tejas by its update notes, so a change that carries none
 * leaves thnkr.ing with nothing to tell him. Rather than let that reach his screen, the release
 * asks the session that made the change to write its note while the update waits: the update is
 * already waiting for that session, and the note is one sentence.
 *
 * This never holds the release back. An undescribed change stays out of the notice; the ask is a
 * prompt to the author, not a gate, and a change nobody can be asked about is simply left alone.
 */
const SCOPE = "service:update-notes";

function git(repositoryRoot: string, arguments_: string[]) {
  const result = Bun.spawnSync({
    cmd: ["git", ...arguments_],
    cwd: repositoryRoot,
    env: { ...process.env, HOME: process.env.HOME || "/root", GIT_TERMINAL_PROMPT: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  return result.exitCode === 0 ? Buffer.from(result.stdout).toString("utf8") : "";
}

/** The session whose turn produced this commit, from the provenance trailer it was committed with. */
function authoringSession(repositoryRoot: string, commit: string) {
  const trailers = git(repositoryRoot, ["show", "-s", "--format=%(trailers:key=Concierge-Provenance,valueonly)", commit]);
  for (const token of trailers.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) || []) {
    const provenance = getTurnCommitProvenance(token.toLowerCase());
    if (!provenance) continue;
    const turn = db.query("SELECT session_id FROM turns WHERE id=?").get(provenance.turn_id) as { session_id: number | null } | null;
    if (turn?.session_id) return turn.session_id;
  }
  return null;
}

function ask(repositoryRoot: string, commits: { revision: string; title: string }[]) {
  const listed = commits.map((commit) => `- ${commit.title} (${commit.revision.slice(0, 12)})`).join("\n");
  return [
    "Your change is in the Concierge update now waiting to go out, and it has no update note, so thnkr.ing cannot tell Tejas what the update brings.",
    "",
    listed,
    "",
    "Write one for each, now: one sentence in product language about what changes for him, addressed to him, with no code terms.",
    "",
    `git -C ${repositoryRoot} notes --ref=refs/notes/update add -m "<sentence>" <commit>`,
    `git -C ${repositoryRoot} push origin refs/notes/update`,
    "",
    'Use `internal` as the sentence when he would notice nothing. The note is read while the update waits, so writing it now still reaches him. Nothing is blocked either way; reply with what you wrote.',
  ].join("\n");
}

/** Ask each authoring session once per release for the notes its changes are missing. */
export function requestMissingUpdateNotes(input: { runId: string; repositoryRoot: string; baseCommit: string; candidateCommit: string }) {
  let asked = 0;
  try {
    const missing = changesMissingUpdateNotes(input.baseCommit, input.candidateCommit);
    if (!missing.length) return 0;
    const bySession = new Map<number, { revision: string; title: string }[]>();
    for (const change of missing) {
      const session = authoringSession(input.repositoryRoot, change.revision);
      if (!session) continue;
      bySession.set(session, [...(bySession.get(session) ?? []), change]);
    }
    for (const [sessionId, commits] of bySession) {
      // One ask per session per release: the action id makes a repeated prepare idempotent.
      const saved = retainSessionInput({
        sessionId, scope: SCOPE, actionId: `${input.runId}:${sessionId}`, kind: "input", origin: "agent",
        payload: { text: ask(input.repositoryRoot, commits) },
      });
      if (saved.duplicate) continue;
      enqueueSessionInput(saved.input.id);
      asked += 1;
    }
    log("info", "update_notes_requested", { deployment_run_id: input.runId, changes: missing.length, sessions: asked });
  } catch (error) {
    // Never let describing an update interfere with shipping it.
    log("error", "update_notes_request_failed", {
      deployment_run_id: input.runId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return asked;
}
