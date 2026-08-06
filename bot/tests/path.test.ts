import { describe, expect, test } from "bun:test";

describe("channel path mapping", () => {
  test("single segment", () => {
    process.env.CONCIERGE_STATE_DIR = "/tmp/concierge-state-test";
    const { pathFromChannelName } = require("../src/channel");
    expect(pathFromChannelName("foo")).toEqual({ group: null, name: "foo", rel: "foo" });
  });

  test("underscore maps to directory hierarchy", () => {
    process.env.CONCIERGE_STATE_DIR = "/tmp/concierge-state-test";
    const { pathFromChannelName } = require("../src/channel");
    expect(pathFromChannelName("a_b_c_d")).toEqual({ group: "a", name: "d", rel: "a/b/c/d" });
  });

  test("hyphens remain within path segment", () => {
    process.env.CONCIERGE_STATE_DIR = "/tmp/concierge-state-test";
    const { projectPaths } = require("../src/channel");
    expect(projectPaths("blogs_binding-values").vault).toBe("/root/workspace/vault/blogs/binding-values");
    expect(projectPaths("blogs_binding-values").code).toBe("/root/workspace/blogs/binding-values");
  });
});
