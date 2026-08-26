import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { attachmentPrompt, cleanupAttachmentBundle, createTurnAttachmentRoot, parseSlackMessageFilesJson } from "../src/attachments";
import { prepareProviderInput } from "../src/provider-input";

const dir = "/tmp/concierge-attachments-test";
const originalFetch = globalThis.fetch;
let attachmentRoot: string | null = null;

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await cleanupAttachmentBundle({ dir, files: [] });
  await cleanupAttachmentBundle({ dir: attachmentRoot, files: [] });
  attachmentRoot = null;
});

describe("prepareProviderInput", () => {
  test("keeps image and document bytes in the turn root without putting credentials or temporary paths in replay", async () => {
    attachmentRoot = await createTurnAttachmentRoot(1);
    const bodies = ["image bytes", "document bytes"];
    let downloads = 0;
    globalThis.fetch = (async (_url, init) => {
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-token");
      return new Response(bodies[downloads++]);
    }) as typeof fetch;
    const prepared = await prepareProviderInput({
      prompt: "Check the steps bar", text: "Check the steps bar", channel: "C1", messageTs: "1.2",
      user: "U1", client: {}, botToken: "test-token", hydrateSlackLinks: false, attachmentRoot,
      files: [
        { id: "F1", name: "screen shot.png", mimetype: "image/png", url_private: "https://files.slack.test/image" },
        { id: "F2", name: "notes.pdf", mimetype: "application/pdf", url_private: "https://files.slack.test/pdf" },
      ],
    });
    expect(prepared.attachmentBundle.dir).toBe(join(attachmentRoot, "1.2"));
    expect(prepared.attachmentBundle.files.map((file) => readFileSync(file.path, "utf8"))).toEqual(bodies);
    expect(prepared.prompt).toContain("Check the steps bar");
    expect(prepared.prompt).toContain("Inspect the attached file contents");
    for (const file of prepared.attachmentBundle.files) expect(prepared.prompt).toContain(file.path);
    expect(prepared.prompt).not.toContain("test-token");
    expect(prepared.prompt).not.toContain("https://files.slack.test");
    expect(prepared.replayText).toBe("Check the steps bar");
    expect(prepared.unreplayableAttachmentCount).toBe(2);
  });

  test("prepares audio-only guidance with a replayable transcript", async () => {
    attachmentRoot = await createTurnAttachmentRoot(2);
    globalThis.fetch = (async () => new Response("audio bytes")) as typeof fetch;
    const prepared = await prepareProviderInput({
      prompt: "", text: "", channel: "C1", messageTs: "2.2", user: "U1", client: {},
      botToken: "test-token", hydrateSlackLinks: false, attachmentRoot,
      files: [{ id: "F3", name: "voice.m4a", mimetype: "audio/mp4", url_private: "https://files.slack.test/audio",
        transcription: { text: "Also check the planning bar" } }],
    });
    expect(prepared.replayText).toContain("Also check the planning bar");
    expect(prepared.replayText).not.toContain(attachmentRoot);
    expect(prepared.unreplayableAttachmentCount).toBe(0);
    expect(prepared.transcriptCount).toBe(1);
    expect(readFileSync(prepared.attachmentBundle.files[0]!.path, "utf8")).toBe("audio bytes");
  });

  test("removes a failed message download without removing an earlier steering attachment", async () => {
    attachmentRoot = await createTurnAttachmentRoot(3);
    const prepare = (messageTs: string) => prepareProviderInput({
      prompt: "", text: "", channel: "C1", messageTs, user: "U1", client: {},
      botToken: "test-token", hydrateSlackLinks: false, attachmentRoot: attachmentRoot!,
      files: [{ id: "F4", name: "file.txt", url_private: "https://files.slack.test/file" }],
    });
    globalThis.fetch = (async () => new Response("kept")) as typeof fetch;
    const earlier = await prepare("3.1");
    globalThis.fetch = (async () => { throw new Error("download disconnected"); }) as typeof fetch;
    await expect(prepare("3.2")).rejects.toThrow("download disconnected");
    expect(existsSync(join(attachmentRoot, "3.2"))).toBeFalse();
    expect(readFileSync(earlier.attachmentBundle.files[0]!.path, "utf8")).toBe("kept");
  });
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
