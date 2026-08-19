import { describe, expect, test } from "bun:test";
import {
  configuredSkillRoutes,
  loadSkillPrompt,
  selectSkillRoute,
  SUBSTACK_EDITOR_SKILL_PATH,
} from "../src/skill-routes";

describe("skill routes", () => {
  test("the Substack mention selects and loads the canonical workspace skill", () => {
    const selected = selectSkillRoute(
      configuredSkillRoutes("USUBSTACK"),
      "Please ask @substack-editor to revise this.",
    );
    const reads: string[] = [];

    const prompt = loadSkillPrompt(selected, {
      exists: (path) => path === SUBSTACK_EDITOR_SKILL_PATH,
      read: (path) => {
        reads.push(path);
        return "canonical Substack skill";
      },
    });

    expect(selected?.skillPath).toBe(
      "/root/workspace/skills/substack-editor-v0-skill/SKILL.md",
    );
    expect(reads).toEqual([SUBSTACK_EDITOR_SKILL_PATH]);
    expect(prompt).toBe("canonical Substack skill");
  });

  test("the configured Slack user ID selects the same route", () => {
    const selected = selectSkillRoute(
      configuredSkillRoutes("USUBSTACK"),
      "Please ask <@USUBSTACK> to revise this.",
    );

    expect(selected?.name).toBe("substack-editor");
    expect(selected?.skillPath).toBe(SUBSTACK_EDITOR_SKILL_PATH);
  });
});
