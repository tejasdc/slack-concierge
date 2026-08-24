import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ProjectionWatcher } from "./projection-watcher";
import type { ChannelRow } from "./state";

type ProjectionReason = "startup" | "file-change" | "capture" | "channel-created";

export class TodoFileWatcher extends ProjectionWatcher<ProjectionReason> {

  constructor(
    private readonly project: (channel: ChannelRow, reason: ProjectionReason) => Promise<unknown>,
    private readonly debounceMs = 100,
    private readonly retryMs = 30_000,
  ) {
    super({
      name: "todo",
      startupReason: "startup",
      changedReason: "file-change",
      resolveTarget(channel) {
        const notesDirectory = join(channel.vault_path, "notes");
        mkdirSync(notesDirectory, { recursive: true });
        return { directory: notesDirectory, filename: "TODOS.md" };
      },
      project,
      debounceMs,
      retryMs,
    });
  }

  schedule(channel: ChannelRow, reason: ProjectionReason = "capture") {
    super.schedule(channel, reason);
  }
}
