import { beforeEach, describe, expect, test } from "bun:test";
import { slackBucket } from "../src/rate-limit";
import { postLongReply } from "../src/slack-post";

function nativeTable(call: Record<string, any>) {
  return call.blocks.find((block: Record<string, unknown>) => block.type === "table");
}

function cellElements(table: Record<string, any>, row: number, column: number) {
  return table.rows[row][column].elements[0].elements;
}

describe("final Slack replies", () => {
  beforeEach(() => slackBucket.reset());

  test("wraps every native table column while preserving surrounding Markdown", async () => {
    const calls: Array<Record<string, any>> = [];
    const table = [
      "TL;DR: Compared the three surfaces.",
      "",
      "| Surface | Best at | Cognitive timescale |",
      "| --- | --- | --- |",
      "| Thinkering | Forming thought | Seconds to hours |",
      "| Slack | Steering agents | Hours to days |",
      "| Obsidian | Ratified memory | Days to years |",
      "",
      "- [x] Comparison complete",
    ].join("\n");
    const client = {
      chat: {
        postMessage: async (args: Record<string, unknown>) => {
          calls.push(args);
          return { ok: true, ts: "100.000001" };
        },
      },
    };

    await postLongReply({
      client,
      channel: "C1",
      threadTs: "99.000001",
      text: table,
      idempotencyKey: "turn:1:outcome",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      channel: "C1",
      thread_ts: "99.000001",
      client_msg_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(calls[0]!.blocks.map((block: Record<string, unknown>) => block.type)).toEqual([
      "markdown",
      "table",
      "markdown",
    ]);
    expect(calls[0]!.blocks[0].text).toBe("TL;DR: Compared the three surfaces.\n\n");
    expect(calls[0]!.blocks[2].text).toBe("\n- [x] Comparison complete");
    const tableBlock = nativeTable(calls[0]!);
    expect(tableBlock.column_settings).toEqual([
      { align: "left", is_wrapped: true },
      { align: "left", is_wrapped: true },
      { align: "left", is_wrapped: true },
    ]);
    expect(tableBlock.rows).toHaveLength(4);
    expect(tableBlock.rows.every((row: unknown[]) => row.length === 3)).toBe(true);
  });

  test("wraps long contents in both columns without changing the two-column shape", async () => {
    const calls: Array<Record<string, any>> = [];
    const client = {
      chat: {
        postMessage: async (args: Record<string, unknown>) => {
          calls.push(args);
          return { ok: true, ts: "100.000001" };
        },
      },
    };
    const response = [
      "| Component | Function in the factory |",
      "| --- | --- |",
      `| KB with a deliberately long name | ${"A Git-backed write, retrieval, and promotion path. ".repeat(12)} |`,
    ].join("\n");

    await postLongReply({ client, channel: "C1", threadTs: "99.000001", text: response });

    const table = nativeTable(calls[0]!);
    expect(table.column_settings).toEqual([
      { align: "left", is_wrapped: true },
      { align: "left", is_wrapped: true },
    ]);
    expect(table.rows.every((row: unknown[]) => row.length === 2)).toBe(true);
    expect(cellElements(table, 1, 1)[0].text).toStartWith("A Git-backed write");
  });

  test("keeps oversized cell continuations in their original columns", async () => {
    const calls: Array<Record<string, any>> = [];
    const client = {
      chat: {
        postMessage: async (args: Record<string, unknown>) => {
          calls.push(args);
          return { ok: true, ts: String(calls.length) };
        },
      },
    };
    const longValue = "x".repeat(3_900);
    const response = `| A | B |\n| --- | --- |\n| left | ${longValue} |`;

    await postLongReply({ client, channel: "C1", threadTs: "99.000001", text: response });

    expect(calls.length).toBeGreaterThan(1);
    expect(calls.every((call) => nativeTable(call).rows.every((row: unknown[]) => row.length === 2))).toBe(true);
    const bodyRows = calls.flatMap((call) => nativeTable(call).rows.slice(1));
    expect(bodyRows.slice(1).every((row) => row[0].elements[0].elements[0].text === " ")).toBe(true);
    expect(bodyRows.flatMap((row) => row[1].elements[0].elements)
      .map((element: Record<string, unknown>) => element.text || "").join(""))
      .toBe(longValue);
  });

  test("keeps formatting and links self-contained across oversized cell continuations", async () => {
    const cases = [
      { content: "code | content ".repeat(300), sourceStyle: "code", type: "text", style: { code: true } },
      { content: `${"x".repeat(1_881)}\\${"y".repeat(2_500)}`, sourceStyle: "code", type: "text", style: { code: true } },
      { content: "bold content ".repeat(350).trimEnd(), sourceStyle: "bold", type: "text", style: { bold: true } },
      {
        content: "bold italic content ".repeat(300).trimEnd(),
        sourceStyle: "boldItalic",
        type: "text",
        style: { bold: true, italic: true },
      },
      { content: "linked content ".repeat(350), sourceStyle: "link", type: "link", style: undefined },
    ];

    for (const [caseIndex, inline] of cases.entries()) {
      const calls: Array<Record<string, any>> = [];
      const client = {
        chat: {
          postMessage: async (args: Record<string, unknown>) => {
            calls.push(args);
            return { ok: true, ts: String(calls.length) };
          },
        },
      };
      const source = inline.sourceStyle === "code" ? `\`${inline.content}\``
        : inline.sourceStyle === "bold" ? `**${inline.content}**`
          : inline.sourceStyle === "boldItalic" ? `***${inline.content}***`
            : `[${inline.content}](https://example.com/a_(b))`;
      const response = `| A | B |\n| --- | --- |\n| left | ${source} |`;

      await postLongReply({
        client,
        channel: "C1",
        threadTs: "99.000001",
        text: response,
        idempotencyKey: `formatted:${caseIndex}`,
      });

      expect(calls.length).toBeGreaterThan(1);
      expect(calls.every((call) => nativeTable(call).rows.every((row: unknown[]) => row.length === 2))).toBe(true);
      const continuedElements = calls.flatMap((call) => nativeTable(call).rows.slice(1)
        .flatMap((row: Record<string, any>[]) => row[1]!.elements[0].elements));
      const substantiveElements = continuedElements.filter((element: Record<string, unknown>) =>
        String(element.text || "").trim());
      expect(substantiveElements.every((element: Record<string, unknown>) => element.type === inline.type)).toBe(true);
      if (inline.style) {
        expect(substantiveElements.every((element: Record<string, unknown>) =>
          JSON.stringify(element.style) === JSON.stringify(inline.style))).toBe(true);
      } else {
        expect(substantiveElements.every((element: Record<string, unknown>) =>
          element.url === "https://example.com/a_(b)")).toBe(true);
      }
      expect(continuedElements.map((element: Record<string, unknown>) => element.text || "").join(""))
        .toBe(inline.content);
    }
  });

  test("preserves cell line breaks across semantic continuations", async () => {
    const calls: Array<Record<string, any>> = [];
    const client = {
      chat: {
        postMessage: async (args: Record<string, unknown>) => {
          calls.push(args);
          return { ok: true, ts: String(calls.length) };
        },
      },
    };
    const response = `| A | B |\n| --- | --- |\n| left | before<br>after ${"x".repeat(3_900)} |`;

    await postLongReply({ client, channel: "C1", threadTs: "99.000001", text: response });

    const renderedText = calls.flatMap((call) => nativeTable(call).rows.slice(1)
      .flatMap((row: Record<string, any>[]) => row[1]!.elements[0].elements))
      .map((element: Record<string, unknown>) => element.text || "")
      .join("");
    expect(renderedText).toBe(`before\nafter ${"x".repeat(3_900)}`);
    expect(renderedText).not.toContain("<br>");
  });

  test("keeps every column in wide tables and preserves declared alignment", async () => {
    const calls: Array<Record<string, any>> = [];
    const client = {
      chat: {
        postMessage: async (args: Record<string, unknown>) => {
          calls.push(args);
          return { ok: true, ts: "100.000001" };
        },
      },
    };
    const headers = Array.from({ length: 20 }, (_, index) => `Column ${index + 1}`);
    const delimiters = headers.map((_, index) => index === 1 ? ":---:" : index === 19 ? "---:" : "---");
    const values = headers.map((_, index) => `Value ${index + 1}`);
    const response = [
      `| ${headers.join(" | ")} |`,
      `| ${delimiters.join(" | ")} |`,
      `| ${values.join(" | ")} |`,
    ].join("\n");

    await postLongReply({ client, channel: "C1", threadTs: "99.000001", text: response });

    const table = nativeTable(calls[0]!);
    expect(table.rows.every((row: unknown[]) => row.length === 20)).toBe(true);
    expect(table.column_settings).toHaveLength(20);
    expect(table.column_settings.every((column: Record<string, unknown>) => column.is_wrapped === true)).toBe(true);
    expect(table.column_settings[1].align).toBe("center");
    expect(table.column_settings[19].align).toBe("right");
  });

  test("keeps every fallback chunk within budget when a wide header cannot repeat", async () => {
    const calls: Array<Record<string, any>> = [];
    const client = {
      chat: {
        postMessage: async (args: Record<string, unknown>) => {
          calls.push(args);
          return { ok: true, ts: String(calls.length) };
        },
      },
    };
    const headers = Array.from({ length: 20 }, (_, index) =>
      `${String(index).padStart(2, "0")}${"h".repeat(174)}`);
    const response = [
      `| ${headers.join(" | ")} |`,
      `| ${headers.map(() => "---").join(" | ")} |`,
      `| ${headers.map(() => "<@U12345678>").join(" | ")} |`,
    ].join("\n");

    await postLongReply({ client, channel: "C1", threadTs: "99.000001", text: response });

    expect(calls.length).toBeGreaterThan(1);
    expect(calls.every((call) => Array.from(call.text.replace(/\n\n\(\d+\/\d+\)$/, "")).length <= 3_800)).toBe(true);
    expect(calls.every((call) => nativeTable(call).rows.every((row: unknown[]) => row.length === 20))).toBe(true);
    const mentions = calls.flatMap((call) => nativeTable(call).rows)
      .flatMap((row: Record<string, any>[]) => row)
      .flatMap((cell: Record<string, any>) => cell.elements[0].elements)
      .filter((element: Record<string, unknown>) => element.type === "user");
    expect(mentions).toHaveLength(20);
  });

  test("stages long links across columns without exceeding fallback or table limits", async () => {
    const calls: Array<Record<string, any>> = [];
    const client = {
      chat: {
        postMessage: async (args: Record<string, unknown>) => {
          calls.push(args);
          return { ok: true, ts: String(calls.length) };
        },
      },
    };
    const headers = Array.from({ length: 20 }, (_, index) => `Column ${index + 1}`);
    const urls = headers.map((_, index) =>
      `https://example.com/${String(index).padStart(2, "0")}${"a".repeat(580)}`);
    const response = [
      `| ${headers.join(" | ")} |`,
      `| ${headers.map(() => "---").join(" | ")} |`,
      `| ${urls.map((url) => `[x](${url})`).join(" | ")} |`,
    ].join("\n");

    await postLongReply({ client, channel: "C1", threadTs: "99.000001", text: response });

    expect(calls.length).toBeGreaterThan(1);
    expect(calls.every((call) =>
      Array.from(call.text.replace(/\n\n\(\d+\/\d+\)$/, "")).length <= 3_800)).toBe(true);
    expect(calls.every((call) => nativeTable(call).rows.every((row: unknown[]) => row.length === 20))).toBe(true);
    const links = calls.flatMap((call) => nativeTable(call).rows)
      .flatMap((row: Record<string, any>[]) => row)
      .flatMap((cell: Record<string, any>) => cell.elements[0].elements)
      .filter((element: Record<string, unknown>) => element.type === "link");
    expect(links).toHaveLength(20);
    expect(links.map((link: Record<string, unknown>) => link.url)).toEqual(urls);
    expect(links.every((link: Record<string, unknown>) => link.text === "x")).toBe(true);
    expect(calls.every((call) => nativeTable(call).rows
      .flatMap((row: Record<string, any>[]) => row)
      .flatMap((cell: Record<string, any>) => cell.elements[0].elements)
      .reduce((total: number, element: Record<string, unknown>) =>
        total + Array.from(String(element.text || "")).length + Array.from(String(element.url || "")).length, 0)
      <= 10_000)).toBe(true);
  });

  test("keeps a globally fitting labeled link atomic", async () => {
    const calls: Array<Record<string, any>> = [];
    const client = {
      chat: {
        postMessage: async (args: Record<string, unknown>) => {
          calls.push(args);
          return { ok: true, ts: String(calls.length) };
        },
      },
    };
    const url = `https://example.com/${"a".repeat(2_480)}`;
    const response = `| A | B |\n| --- | --- |\n| left | [documentation](${url}) |`;

    await postLongReply({ client, channel: "C1", threadTs: "99.000001", text: response });

    expect(calls).toHaveLength(1);
    expect(cellElements(nativeTable(calls[0]!), 1, 1)).toEqual([{
      type: "link",
      url,
      text: "documentation",
    }]);
  });

  test("resumes repeated headers after a row needs a headerless page", async () => {
    const calls: Array<Record<string, any>> = [];
    const client = {
      chat: {
        postMessage: async (args: Record<string, unknown>) => {
          calls.push(args);
          return { ok: true, ts: String(calls.length) };
        },
      },
    };
    const urlPrefix = "https://e.co/";
    const url = urlPrefix + "u".repeat(3_770 - urlPrefix.length);
    const response = [
      "| A | B |",
      "| --- | --- |",
      "| first | small |",
      `| long | [x](${url}) |`,
      ...Array.from({ length: 20 }, (_, index) => `| tail-${index} | ok |`),
    ].join("\n");

    await postLongReply({ client, channel: "C1", threadTs: "99.000001", text: response });

    const linkPageIndex = calls.findIndex((call) => nativeTable(call).rows
      .some((row: Record<string, any>[]) => row.some((cell) => cell.elements[0].elements
        .some((element: Record<string, unknown>) => element.type === "link"))));
    const tailPageIndex = calls.findIndex((call) => nativeTable(call).rows
      .some((row: Record<string, any>[]) => row.some((cell) => cell.elements[0].elements
        .some((element: Record<string, unknown>) => element.text === "tail-0"))));
    expect(linkPageIndex).toBeGreaterThanOrEqual(0);
    expect(tailPageIndex).toBeGreaterThan(linkPageIndex);
    expect(cellElements(nativeTable(calls[tailPageIndex]!), 0, 0)).toEqual([{
      type: "text",
      text: "A",
      style: { bold: true },
    }]);
    expect(cellElements(nativeTable(calls[tailPageIndex]!), 0, 1)).toEqual([{
      type: "text",
      text: "B",
      style: { bold: true },
    }]);
  });

  test("keeps above-limit table source intact instead of dropping columns", async () => {
    const calls: Array<Record<string, any>> = [];
    const client = {
      chat: {
        postMessage: async (args: Record<string, unknown>) => {
          calls.push(args);
          return { ok: true, ts: "100.000001" };
        },
      },
    };
    const headers = Array.from({ length: 21 }, (_, index) => `Column ${index + 1}`);
    const response = [
      `| ${headers.join(" | ")} |`,
      `| ${headers.map(() => "---").join(" | ")} |`,
      `| ${headers.map((_, index) => `Value ${index + 1}`).join(" | ")} |`,
    ].join("\n");

    await postLongReply({ client, channel: "C1", threadTs: "99.000001", text: response });

    expect(calls[0]!.blocks).toEqual([{ type: "markdown", text: response }]);
    expect(calls[0]!.text).toContain("Column 21");
    expect(calls[0]!.text).toContain("Value 21");
  });

  test("preserves supported inline formatting and pipes inside table cells", async () => {
    const calls: Array<Record<string, any>> = [];
    const client = {
      chat: {
        postMessage: async (args: Record<string, unknown>) => {
          calls.push(args);
          return { ok: true, ts: "100.000001" };
        },
      },
    };
    const response = [
      "| Component | Details |",
      "| --- | --- |",
      "| **KB** | [KB documentation](https://example.com/kb) with `read | write`, _retrieval_, ***combined***, `<br>`, <https://example.com/docs\\|Docs>, <#C123ABC\\|general>, notes/inbox_file.md, and A \\| B :books: |",
    ].join("\n");

    await postLongReply({ client, channel: "C1", threadTs: "99.000001", text: response });

    const table = nativeTable(calls[0]!);
    expect(cellElements(table, 1, 0)).toEqual([
      { type: "text", text: "KB", style: { bold: true } },
    ]);
    expect(cellElements(table, 1, 1)).toContainEqual({
      type: "link",
      url: "https://example.com/kb",
      text: "KB documentation",
    });
    expect(cellElements(table, 1, 1)).toContainEqual({
      type: "text",
      text: "read | write",
      style: { code: true },
    });
    expect(cellElements(table, 1, 1)).toContainEqual({
      type: "text",
      text: "retrieval",
      style: { italic: true },
    });
    expect(cellElements(table, 1, 1)).toContainEqual({
      type: "text",
      text: "combined",
      style: { bold: true, italic: true },
    });
    expect(cellElements(table, 1, 1)).toContainEqual({
      type: "text",
      text: "<br>",
      style: { code: true },
    });
    expect(cellElements(table, 1, 1)).toContainEqual({
      type: "link",
      url: "https://example.com/docs",
      text: "Docs",
    });
    expect(cellElements(table, 1, 1)).toContainEqual({
      type: "channel",
      channel_id: "C123ABC",
    });
    expect(cellElements(table, 1, 1)).toContainEqual({ type: "emoji", name: "books" });
    expect(cellElements(table, 1, 1).map((element: Record<string, unknown>) => element.text || "").join(""))
      .toContain("notes/inbox_file.md, and A | B");
  });

  test("preserves literal path separators and balanced-parenthesis links in cells", async () => {
    const calls: Array<Record<string, any>> = [];
    const client = {
      chat: {
        postMessage: async (args: Record<string, unknown>) => {
          calls.push(args);
          return { ok: true, ts: "100.000001" };
        },
      },
    };
    const response = [
      "| Path | Reference |",
      "| --- | --- |",
      "| C:\\Users\\Tejas | [Foo](https://example.com/a_(b)) |",
    ].join("\n");

    await postLongReply({ client, channel: "C1", threadTs: "99.000001", text: response });

    const table = nativeTable(calls[0]!);
    expect(cellElements(table, 1, 0)).toEqual([{ type: "text", text: "C:\\Users\\Tejas" }]);
    expect(cellElements(table, 1, 1)).toEqual([{
      type: "link",
      url: "https://example.com/a_(b)",
      text: "Foo",
    }]);
  });

  test("keeps table-like text in fenced code inside a native Markdown block", async () => {
    const calls: Array<Record<string, any>> = [];
    const client = {
      chat: {
        postMessage: async (args: Record<string, unknown>) => {
          calls.push(args);
          return { ok: true, ts: "100.000001" };
        },
      },
    };
    const response = "```markdown\n| A | B |\n| --- | --- |\n| C | D |\n```not-a-close\n| E | F |\n| --- | --- |\n```";

    await postLongReply({ client, channel: "C1", threadTs: "99.000001", text: response });

    expect(calls[0]!.blocks).toEqual([{ type: "markdown", text: response }]);
  });

  test("keeps table-like text in indented code inside a native Markdown block", async () => {
    const calls: Array<Record<string, any>> = [];
    const client = {
      chat: {
        postMessage: async (args: Record<string, unknown>) => {
          calls.push(args);
          return { ok: true, ts: "100.000001" };
        },
      },
    };
    const response = "    | A | B |\n    | --- | --- |\n    | C | D |";

    await postLongReply({ client, channel: "C1", threadTs: "99.000001", text: response });

    expect(calls[0]!.blocks).toEqual([{ type: "markdown", text: response }]);
  });

  test("posts multiple tables separately to honor Slack's one-table-per-message limit", async () => {
    const calls: Array<Record<string, any>> = [];
    const client = {
      chat: {
        postMessage: async (args: Record<string, unknown>) => {
          calls.push(args);
          return { ok: true, ts: String(calls.length) };
        },
      },
    };
    const response = [
      "First:",
      "",
      "| A | B |",
      "| --- | --- |",
      "| 1 | 2 |",
      "",
      "Between tables.",
      "",
      "| C | D |",
      "| --- | --- |",
      "| 3 | 4 |",
      "",
      "After both.",
    ].join("\n");

    await postLongReply({ client, channel: "C1", threadTs: "99.000001", text: response });

    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.blocks.filter((block: Record<string, unknown>) => block.type === "table").length === 1))
      .toBe(true);
    expect(calls[0]!.text).toContain("Between tables.");
    expect(calls[0]!.text).toEndWith("(1/2)");
    expect(calls[1]!.text).toContain("After both.");
    expect(calls[1]!.text).toEndWith("(2/2)");
  });

  test("retains durable chunk indexes when recovery skips an already delivered table", async () => {
    const calls: Array<Record<string, any>> = [];
    const postedIndexes: number[] = [];
    const client = {
      chat: {
        postMessage: async (args: Record<string, unknown>) => {
          calls.push(args);
          return { ok: true, ts: "100.000002" };
        },
      },
    };
    const response = [
      "| A | B |",
      "| --- | --- |",
      "| 1 | 2 |",
      "",
      "| C | D |",
      "| --- | --- |",
      "| 3 | 4 |",
    ].join("\n");

    await postLongReply({
      client,
      channel: "C1",
      threadTs: "99.000001",
      text: response,
      idempotencyKey: "turn:1:outcome",
      skipChunkIndexes: new Set([0]),
      onChunkPosted: (index) => postedIndexes.push(index),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toContain("| C | D |");
    expect(calls[0]!.text).toEndWith("(2/2)");
    expect(postedIndexes).toEqual([1]);
  });

  test("repeats the header when a table exceeds Slack's 100-row limit", async () => {
    const calls: Array<Record<string, any>> = [];
    const client = {
      chat: {
        postMessage: async (args: Record<string, unknown>) => {
          calls.push(args);
          return { ok: true, ts: String(calls.length) };
        },
      },
    };
    const response = [
      "| Item | Value |",
      "| --- | --- |",
      ...Array.from({ length: 100 }, (_, index) => `| ${index + 1} | v |`),
    ].join("\n");

    await postLongReply({ client, channel: "C1", threadTs: "99.000001", text: response });

    expect(calls).toHaveLength(2);
    expect(nativeTable(calls[0]!).rows).toHaveLength(100);
    expect(nativeTable(calls[1]!).rows).toHaveLength(2);
    expect(cellElements(nativeTable(calls[0]!), 0, 0)[0]).toMatchObject({ text: "Item", style: { bold: true } });
    expect(cellElements(nativeTable(calls[1]!), 0, 0)[0]).toMatchObject({ text: "Item", style: { bold: true } });
  });

  test("shows continuation labels inside each visible Markdown block", async () => {
    const calls: Array<Record<string, any>> = [];
    const client = {
      chat: {
        postMessage: async (args: Record<string, unknown>) => {
          calls.push(args);
          return { ok: true, ts: String(calls.length) };
        },
      },
    };

    await postLongReply({
      client,
      channel: "C1",
      threadTs: "99.000001",
      text: "Paragraph.\n\n".repeat(500),
    });

    expect(calls.length).toBeGreaterThan(1);
    expect(calls.every((call, index) =>
      call.blocks[0].type === "markdown"
      && call.blocks[0].text.endsWith(`(${index + 1}/${calls.length})`),
    )).toBe(true);
  });
});
