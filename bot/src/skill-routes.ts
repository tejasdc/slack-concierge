import { existsSync, readFileSync } from "node:fs";

export const SUBSTACK_EDITOR_SKILL_PATH =
  "/root/workspace/skills/substack-editor-v0-skill/SKILL.md";

export interface SkillRoute {
  name: string;
  userId?: string;
  match: RegExp;
  skillPath: string;
}

export function configuredSkillRoutes(substackEditorUserId?: string): SkillRoute[] {
  return [
    {
      name: "substack-editor",
      userId: substackEditorUserId,
      match: /@substack-editor/i,
      skillPath: SUBSTACK_EDITOR_SKILL_PATH,
    },
  ];
}

export function selectSkillRoute(routes: SkillRoute[], text: string): SkillRoute | undefined {
  return routes.find(
    (route) =>
      (route.userId && text.includes(`<@${route.userId}>`)) || route.match.test(text),
  );
}

export function loadSkillPrompt(
  skill: SkillRoute | undefined,
  files: {
    exists: (path: string) => boolean;
    read: (path: string) => string;
  } = {
    exists: existsSync,
    read: (path) => readFileSync(path, "utf-8"),
  },
): string | undefined {
  if (!skill) return undefined;
  if (files.exists(skill.skillPath)) return files.read(skill.skillPath);
  return `You are acting as ${skill.name}. The skill file is expected at ${skill.skillPath}, but it is not present yet.`;
}
