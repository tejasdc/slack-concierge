import { describe, expect, test } from "bun:test";
import { splitSlackText } from "../src/text";

describe("splitSlackText", () => {
  test("keeps short text intact", () => {
    expect(splitSlackText("hello", 10)).toEqual(["hello"]);
  });

  test("splits long text under limit", () => {
    const chunks = splitSlackText("one two three four five", 9);
    expect(chunks.every((chunk) => chunk.length <= 9)).toBe(true);
    expect(chunks.join(" ")).toBe("one two three four five");
  });
});
