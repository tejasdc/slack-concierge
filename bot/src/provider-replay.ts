import type { ProviderId } from "./state";
import { providerThreadHasCodexRemoteInput } from "./state";

export function assertProviderHistoryReplayable(
  session: { provider_id: ProviderId; agent_session_uuid: string },
  operation: "comparison" | "fork",
) {
  if (session.provider_id !== "codex") return;
  if (!providerThreadHasCodexRemoteInput(session.agent_session_uuid)) return;
  if (operation === "comparison") {
    throw new Error(
      "This Codex session contains input sent through Codex Remote. Concierge cannot safely replay an incomplete history for comparison.",
    );
  }
  throw new Error(
    "This Codex session contains input sent through Codex Remote. Concierge cannot yet prove an exact replay boundary that includes that input, so comparison and fork are disabled for this session.",
  );
}
