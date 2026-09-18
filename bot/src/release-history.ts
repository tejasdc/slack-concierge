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
