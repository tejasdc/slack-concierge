import { describe, expect, test } from "bun:test";
import { slackTranscript, transcribeAudioAttachments, transcriptionPrompt } from "../src/transcription";

const downloaded = {
  slackFileId: "F123",
  filename: "01-F123-clip.m4a",
  title: "Audio Clip.m4a",
  mimetype: "audio/mp4",
  filetype: "m4a",
  size: 1234,
  url: "https://files.slack.com/clip.m4a",
  path: "/tmp/attachments/clip.m4a",
};

describe("slackTranscript", () => {
  test("extracts Slack line content when available", () => {
    expect(slackTranscript({ status: "complete", lines: [{ contents: "first" }, { text: "second" }] })).toBe("first second");
  });

  test("ignores an unavailable Slack transcription", () => {
    expect(slackTranscript({ status: "none" })).toBeNull();
  });
});

describe("transcribeAudioAttachments", () => {
  test("uses Slack transcription without invoking local tools", async () => {
    const calls: string[] = [];
    const transcripts = await transcribeAudioAttachments({
      slackFiles: [{ id: "F123", mimetype: "audio/mp4", transcription: { text: "spoken request" } }],
      downloadedFiles: [downloaded],
      runCommand: async (command) => { calls.push(command); return { stdout: "", stderr: "" }; },
    });
    expect(calls).toEqual([]);
    expect(transcripts).toEqual([{ slackFileId: "F123", title: "Audio Clip.m4a", text: "spoken request", source: "slack" }]);
  });

  test("converts and transcribes audio locally when Slack has no text", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const transcripts = await transcribeAudioAttachments({
      slackFiles: [{ id: "F123", media_display_type: "audio", transcription: { status: "none" } }],
      downloadedFiles: [downloaded],
      whisperBinary: "/test/whisper-cli",
      whisperModel: "/test/model.bin",
      runCommand: async (command, args) => {
        calls.push({ command, args });
        return command === "ffmpeg" ? { stdout: "", stderr: "" } : { stdout: " transcribed words\n", stderr: "" };
      },
    });
    expect(calls.map((call) => call.command)).toEqual(["ffmpeg", "/test/whisper-cli"]);
    expect(transcripts[0]).toMatchObject({ text: "transcribed words", source: "whisper.cpp" });
    expect(transcriptionPrompt(transcripts)).toContain("Treat each transcription as the user's spoken message");
  });
});
