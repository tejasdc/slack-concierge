import { createReadStream } from "node:fs";
import { splitSlackText } from "./text";
import { ArtifactFile } from "./artifacts";
import { slackCall } from "./rate-limit";
import { log } from "./log";

export async function postLongReply(input: {
  client: any;
  channel: string;
  threadTs: string;
  text: string;
  user?: string;
}) {
  const chunks = splitSlackText(input.text || "(no output)");
  const posted: string[] = [];
  for (const [idx, chunk] of chunks.entries()) {
    const result: any = await slackCall(
      input.client,
      "chat.postMessage",
      {
        channel: input.channel,
        thread_ts: input.threadTs,
        text: chunks.length > 1 ? `${chunk}\n\n(${idx + 1}/${chunks.length})` : chunk,
      },
      { channel: input.channel, user: input.user },
    );
    if (result?.ts) posted.push(result.ts);
  }
  return posted;
}

export async function uploadArtifacts(input: {
  client: any;
  channel: string;
  threadTs: string;
  artifacts: ArtifactFile[];
  user?: string;
}) {
  for (const artifact of input.artifacts) {
    try {
      const res: any = await slackCall(
        input.client,
        "files.uploadV2",
        {
          channel_id: input.channel,
          thread_ts: input.threadTs,
          file: createReadStream(artifact.path),
          filename: artifact.filename,
          title: artifact.filename,
        },
        { channel: input.channel, user: input.user },
      );
      log("info", "artifact_upload_ok", { path: artifact.path, filename: artifact.filename, ok: !!res?.ok, files: res?.files?.map((f: any) => f.id) });
    } catch (err) {
      log("warn", "artifact_upload_failed", { path: artifact.path, error: String(err), stack: (err as any)?.stack?.slice(0, 400) });
    }
  }
}
