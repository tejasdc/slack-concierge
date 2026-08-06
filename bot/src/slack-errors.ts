import { errorFields, log } from "./log";
import { slackCall } from "./rate-limit";

export function slackErrorData(err: unknown): Record<string, any> {
  const data = (err as any)?.data;
  if (data && typeof data === "object") return data;
  if (err && typeof err === "object") return err as Record<string, any>;
  return {};
}

export function slackErrorCode(err: unknown): string {
  const data = slackErrorData(err);
  return String(data.error || (err as Error)?.message || "unknown_error");
}

export function missingScopes(err: unknown): string[] {
  const data = slackErrorData(err);
  if (data.error !== "missing_scope") return [];
  const needed = data.needed ?? data.response_metadata?.needed;
  if (Array.isArray(needed)) return needed.map(String).filter(Boolean);
  return String(needed || "")
    .split(/[,\s]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
}

export function isPaidPlanListError(err: unknown) {
  return [
    "lists_disabled_user_team",
    "list_disabled_user_team",
    "paid_feature_required",
    "feature_not_available",
    "not_allowed_token_type",
  ].includes(slackErrorCode(err));
}

export async function notifyMissingScope(input: {
  client: any;
  channel: string;
  user?: string | null;
  method: string;
  err: unknown;
}) {
  const needed = missingScopes(input.err);
  log("error", "slack_surface_missing_scope", {
    method: input.method,
    channel: input.channel,
    needed,
    ...errorFields(input.err),
  });
  if (!input.user) return;
  try {
    await slackCall(input.client, "chat.postEphemeral", {
      channel: input.channel,
      user: input.user,
      text: `Concierge is missing Slack app scope(s): ${needed.join(", ") || "(unknown)"}. Add them in the Slack app admin, reinstall the app, then run /mode agent-auto again.`,
    });
  } catch (err) {
    log("warn", "missing_scope_ephemeral_failed", {
      method: input.method,
      channel: input.channel,
      ...errorFields(err),
    });
  }
}

