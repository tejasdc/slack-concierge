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

  test("vault under projects/ namespace; code stays flat at workspace root", () => {
    // CONCIERGE_STATE_DIR is set by tests/preload.ts (bunfig.toml preload).
    const { projectPaths } = require("../src/channel");
    // Bot-managed vault dirs live under vault/projects/ so they don't pollute
    // the user's own top-level vault organization. Code side still mirrors
    // the flat ~/workspace/<name>/ layout (R-VAULT-9).
    expect(projectPaths("blogs_binding-values").vault).toBe("/root/workspace/vault/projects/blogs/binding-values");
    expect(projectPaths("blogs_binding-values").code).toBe("/root/workspace/blogs/binding-values");
    expect(projectPaths("blogs").vault).toBe("/root/workspace/vault/projects/blogs");
  });
});
