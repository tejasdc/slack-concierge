import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { log } from "./log";

export interface SlackMessageFile {
  id?: string;
  name?: string;
  title?: string;
  mimetype?: string;
  filetype?: string;
  size?: number;
  url_private?: string;
  url_private_download?: string;
  duration_ms?: number;
  media_display_type?: string;
  transcription?: unknown;
}

export type SlackMessageFilesParseResult =
  | { ok: true; files: SlackMessageFile[] }
  | { ok: false; error: string };

export function parseSlackMessageFilesJson(value: string): SlackMessageFilesParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return { ok: false, error: "files_json is not valid JSON" };
  }
  if (!Array.isArray(parsed)) return { ok: false, error: "files_json is not an array" };

  const stringFields = [
    "id", "name", "title", "mimetype", "filetype", "url_private",
    "url_private_download", "media_display_type",
  ] as const;
  const numberFields = ["size", "duration_ms"] as const;
  for (const [index, file] of parsed.entries()) {
    if (!file || typeof file !== "object" || Array.isArray(file)) {
      return { ok: false, error: `files_json[${index}] is not an object` };
    }
    const record = file as Record<string, unknown>;
    for (const field of stringFields) {
      if (record[field] !== undefined && typeof record[field] !== "string") {
        return { ok: false, error: `files_json[${index}].${field} is not a string` };
      }
    }
    for (const field of numberFields) {
      if (record[field] !== undefined && typeof record[field] !== "number") {
        return { ok: false, error: `files_json[${index}].${field} is not a number` };
      }
    }
  }
  return { ok: true, files: parsed as SlackMessageFile[] };
}

export interface DownloadedSlackFile {
  slackFileId: string;
  filename: string;
  title: string;
  mimetype: string | null;
  filetype: string | null;
  size: number | null;
  url: string;
  path: string;
}

export interface AttachmentBundle {
  dir: string | null;
  files: DownloadedSlackFile[];
}

export function createTurnAttachmentRoot(turnId: number): Promise<string> {
  return mkdtemp(join(tmpdir(), `concierge-turn-${turnId}-attachments-`));
}

export async function downloadSlackFiles(input: {
  files: SlackMessageFile[];
  botToken: string;
  channel: string;
  messageTs: string;
  attachmentRoot: string;
}): Promise<AttachmentBundle> {
  if (input.files.length === 0) return { dir: null, files: [] };
  const missingUrl = input.files.filter((file) => !file?.url_private_download && !file?.url_private);
  if (missingUrl.length > 0) {
    throw new Error(`Slack file metadata missing private download URL for ${missingUrl.length} file(s)`);
  }

  const dir = join(input.attachmentRoot, safePathSegment(input.messageTs));
  await mkdir(dir, { recursive: true });

  try {
    const downloaded: DownloadedSlackFile[] = [];
    for (const [idx, file] of input.files.entries()) {
      const url = file.url_private_download || file.url_private;
      if (!url) continue;
      const slackFileId = file.id || `file-${idx + 1}`;
      const filename = uniqueFilename(idx, slackFileId, file.name || file.title || basename(new URL(url).pathname) || "attachment");
      const path = join(dir, filename);

      log("info", "slack_file_download_started", {
        channel: input.channel,
        message_ts: input.messageTs,
        file_id: slackFileId,
        filename,
        mimetype: file.mimetype || null,
        size: file.size || null,
      });

      const res = await fetchSlackFile(url, input.botToken, slackFileId);

      await pipeline(Readable.fromWeb(res.body as any), createWriteStream(path));
      const record: DownloadedSlackFile = {
        slackFileId,
        filename,
        title: file.title || file.name || filename,
        mimetype: file.mimetype || null,
        filetype: file.filetype || null,
        size: typeof file.size === "number" ? file.size : null,
        url,
        path,
      };
      downloaded.push(record);
      log("info", "slack_file_downloaded", {
        channel: input.channel,
        message_ts: input.messageTs,
        file_id: slackFileId,
        path,
        filename,
      });
    }
    return { dir, files: downloaded };
  } catch (err) {
    await cleanupAttachmentBundle({ dir, files: [] });
    throw err;
  }
}

async function fetchSlackFile(url: string, botToken: string, slackFileId: string) {
  let lastStatus = 0;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${botToken}` },
    });
    if (res.ok && res.body) return res;
    lastStatus = res.status;
    if (![403, 404, 429, 500, 502, 503, 504].includes(res.status) || attempt === 5) break;
    await sleep(attempt * 1500);
  }
  throw new Error(`Slack file download failed for ${slackFileId}: HTTP ${lastStatus || "unknown"}`);
}

export async function cleanupAttachmentBundle(bundle: AttachmentBundle | null | undefined) {
  if (!bundle?.dir) return;
  await rm(bundle.dir, { recursive: true, force: true });
  log("info", "slack_attachment_temp_cleaned", {
    dir: bundle.dir,
    file_count: bundle.files.length,
  });
}

export function attachmentPrompt(
  files: DownloadedSlackFile[],
  options: { transcribedSlackFileIds?: Iterable<string> } = {},
) {
  if (files.length === 0) return "";
  const transcribedSlackFileIds = new Set(options.transcribedSlackFileIds || []);
  const rows = files.map((file, idx) => {
    const meta = [
      file.mimetype ? `mime=${file.mimetype}` : null,
      file.filetype ? `type=${file.filetype}` : null,
      file.size != null ? `bytes=${file.size}` : null,
      `slack_file_id=${file.slackFileId}`,
    ].filter(Boolean).join(", ");
    return `${idx + 1}. ${file.title} (${meta})\n   local_path: ${file.path}`;
  });
  const hasUntranscribedFiles = files.some((file) => !transcribedSlackFileIds.has(file.slackFileId));
  const hasTranscribedFiles = files.some((file) => transcribedSlackFileIds.has(file.slackFileId));
  const inspectionGuidance = [
    hasUntranscribedFiles
      ? "Inspect each attached file that is not already represented by a transcription before answering or routing; do not rely on filenames alone."
      : null,
    hasTranscribedFiles
      ? "Audio attachments with transcriptions above are already represented by those transcriptions. Do not inspect or re-transcribe them unless the transcript is unclear or audio characteristics are directly relevant."
      : null,
  ].filter(Boolean);
  const routerPaths = files.flatMap((file) => ["--file", shellQuote(file.path)]).join(" ");
  return [
    "Slack attachments for this message were downloaded locally for this turn.",
    ...inspectionGuidance,
    "Files:",
    ...rows,
    "",
    "If you are acting as the inbox router and forward this message, re-upload these same files by calling:",
    `/root/.local/bin/router-actions.sh post <target-channel-name> ${routerPaths} -- <message text>`,
  ].join("\n");
}

function uniqueFilename(index: number, slackFileId: string, originalName: string) {
  return `${String(index + 1).padStart(2, "0")}-${safePathSegment(slackFileId)}-${safeFilename(originalName)}`;
}

function safeFilename(input: string) {
  const cleaned = basename(input).replace(/[^A-Za-z0-9._ -]/g, "_").replace(/\s+/g, " ").trim();
  return cleaned.slice(0, 180) || "attachment";
}

function safePathSegment(input: string) {
  return input.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "unknown";
}

function shellQuote(input: string) {
  return `'${input.replace(/'/g, "'\\''")}'`;
}
