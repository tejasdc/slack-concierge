import { slackCall } from "./rate-limit";
import { slackErrorCode } from "./slack-errors";

export async function deliverInlineCaptureConfirmation(input: {
  client: any;
  channel: string;
  threadTs: string;
  userMessageTs: string;
  userText: string;
  userId?: string | null;
  messageClientId: string;
}) {
  const context = { channel: input.channel, user: input.userId || undefined };
  if (/^[!/](?:todo)\s+/i.test(input.userText)) {
    try {
      await slackCall(input.client, "reactions.add", {
        channel: input.channel,
        timestamp: input.userMessageTs,
        name: "white_check_mark",
      }, context);
    } catch (error) {
      if (slackErrorCode(error) !== "already_reacted") throw error;
    }
    return;
  }

  await slackCall(input.client, "chat.postMessage", {
    channel: input.channel,
    thread_ts: input.threadTs,
    text: "note captured",
    client_msg_id: input.messageClientId,
  }, context);
}
