import { describe, expect, test } from "bun:test";

describe("channel path mapping", () => {
  test("single segment", () => {
    // CONCIERGE_STATE_DIR is set by tests/preload.ts (bunfig.toml preload).
    const { pathFromChannelName } = require("../src/channel");
    expect(pathFromChannelName("foo")).toEqual({ group: null, name: "foo", rel: "foo" });
  });

  test("slugifies Slack channel names before creation", () => {
    // CONCIERGE_STATE_DIR is set by tests/preload.ts (bunfig.toml preload).
    const { slugifySlackChannelName } = require("../src/channel");
    expect(slugifySlackChannelName("Hello World!")).toBe("hello-world");
    expect(slugifySlackChannelName("ideaflow_Cortex")).toBe("ideaflow_cortex");
  });

  test("underscore maps to directory hierarchy", () => {
    // CONCIERGE_STATE_DIR is set by tests/preload.ts (bunfig.toml preload).
    const { pathFromChannelName } = require("../src/channel");
    expect(pathFromChannelName("a_b_c_d")).toEqual({ group: "a", name: "d", rel: "a/b/c/d" });
  });

  test("skill channels use the canonical workspace skills namespace", () => {
    const { pathFromChannelName, projectPaths } = require("../src/channel");
    expect(pathFromChannelName("#codex-team-skill")).toEqual({
      group: "skills",
      name: "codex-team-skill",
      rel: "skills/codex-team-skill",
    });
    expect(projectPaths("codex-team-skill")).toEqual({
      group: "skills",
      name: "codex-team-skill",
      rel: "skills/codex-team-skill",
      code: "/root/workspace/skills/codex-team-skill",
      vault: "/root/workspace/vault/projects/skills/codex-team-skill",
    });
  });

  test("skill-like names only route to workspace skills when the channel ends in -skill", () => {
    const { pathFromChannelName } = require("../src/channel");
    expect(pathFromChannelName("codex-team-skill-notes")).toEqual({
      group: null,
      name: "codex-team-skill-notes",
      rel: "codex-team-skill-notes",
    });
  });

  test("vault stays under projects and ordinary code mirrors the channel hierarchy", () => {
    // CONCIERGE_STATE_DIR is set by tests/preload.ts (bunfig.toml preload).
    const { projectPaths } = require("../src/channel");
    // Bot-managed vault dirs live under vault/projects/ so they don't pollute
    // the user's own top-level vault organization. Code mirrors the same
    // hierarchy outside the vault.
    expect(projectPaths("blogs_binding-values").vault).toBe("/root/workspace/vault/projects/blogs/binding-values");
    expect(projectPaths("blogs_binding-values").code).toBe("/root/workspace/blogs/binding-values");
    expect(projectPaths("blogs").vault).toBe("/root/workspace/vault/projects/blogs");
  });
});
