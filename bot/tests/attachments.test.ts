import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { attachmentPrompt, cleanupAttachmentBundle, parseSlackMessageFilesJson } from "../src/attachments";

const dir = "/tmp/concierge-attachments-test";

afterEach(async () => {
  await cleanupAttachmentBundle({ dir, files: [] });
});

describe("attachmentPrompt", () => {
  test("includes local paths and router forwarding syntax", () => {
    const prompt = attachmentPrompt([
      {
        slackFileId: "F123",
        filename: "01-F123-proof.png",
        title: "proof.png",
        mimetype: "image/png",
        filetype: "png",
        size: 1234,
        url: "https://files.slack.com/files-pri/T/F123/proof.png",
        path: "/tmp/inbox-attachments/C123/1700000000.000100/01-F123-proof.png",
      },
    ]);

    expect(prompt).toContain("Inspect the attached file contents");
    expect(prompt).toContain("local_path: /tmp/inbox-attachments/C123/1700000000.000100/01-F123-proof.png");
    expect(prompt).toContain("/root/.local/bin/router-actions.sh post <target-channel-name> --file");
  });
});

describe("parseSlackMessageFilesJson", () => {
  test("accepts persisted Slack file metadata", () => {
    expect(parseSlackMessageFilesJson(JSON.stringify([{
      id: "F123",
      name: "voice.m4a",
      mimetype: "audio/mp4",
      size: 123,
      url_private: "https://files.slack.com/voice.m4a",
    }]))).toEqual({
      ok: true,
      files: [{
        id: "F123",
        name: "voice.m4a",
        mimetype: "audio/mp4",
        size: 123,
        url_private: "https://files.slack.com/voice.m4a",
      }],
    });
  });

  test("rejects malformed persisted metadata without casting it", () => {
    expect(parseSlackMessageFilesJson("not-json")).toEqual({
      ok: false,
      error: "files_json is not valid JSON",
    });
    expect(parseSlackMessageFilesJson('[{"size":"large"}]')).toEqual({
      ok: false,
      error: "files_json[0].size is not a number",
    });
  });
});

describe("cleanupAttachmentBundle", () => {
  test("removes the attachment temp directory", async () => {
    mkdirSync(join(dir, "nested"), { recursive: true });

    await cleanupAttachmentBundle({ dir, files: [] });

    expect(existsSync(dir)).toBe(false);
  });
});
