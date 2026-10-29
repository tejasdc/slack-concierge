/**
 * Project templates: the folders and agent specifications a new project starts with when it is a
 * piece of thinking rather than code (Tejas, 2026-10-29: "we should be able to go and start a
 * brainstorming project or a design project. The design project should come with these basic
 * strings baked in … one of the templates here is a folder for custom agent specification").
 *
 * Modeled on his third-places essay workspace (threads file, numbered research dossiers, outline,
 * drafts, passages, a writing voice used as co-writer). Each template extends the one before it, so
 * a file lives in exactly one place: brainstorm → writing → design. The text ships inside the
 * release bundle, so the server and the Mac lay down identical files.
 */

export const PROJECT_TEMPLATES = ['brainstorm', 'writing', 'design'] as const;
export type ProjectTemplate = (typeof PROJECT_TEMPLATES)[number];

type Files = Record<string, string>;

const brainstorm: Files = {
  'threads.md': `# Threads — {{project}}

{{purpose}}

The shared working memory of this project. Every walkthrough or brainstorm adds one thread:

- the **verbatim quote** Tejas reacted to (so it can be quoted later, with its source),
- **his comment**, near-verbatim and in first person,
- the **open double-clicks**: what to look into next.

Running lists at the bottom: candidate titles, quotable lines, wordplay.

## Threads

## Candidate titles

## Quotable lines
`,
  'research/README.md': `# Research

One dossier per lane, numbered in the order they were opened: \`01-<lane>.md\`, \`02-<lane>.md\`.
Each dossier keeps its sources and quotes with attribution. The research agent owns these files
(see \`../agents/research.md\`); they are working material until the piece ships.
`,
  'agents/README.md': `# Agents for {{project}}

Each file here specifies one standing agent of this project: what it owns, how it starts and which
session it is. Start an agent the first time with Concierge's \`sessions ask --project {{project}}\`,
passing its file as the instructions (\`--text-file agents/<role>.md\`) and naming the session after
the role. Write the session's address on the file's \`session:\` line, and send later work to that
address so one agent keeps the whole context of the topic.
`,
  'agents/research.md': `---
role: research
starts: a new session in this project
session:
---

# Research agent — {{project}}

{{purpose}}

You own the research for this topic. Fan out by lane, write each lane to \`research/NN-<lane>.md\`
with sources and exact quotes, and keep \`threads.md\` current as Tejas reacts: his words verbatim,
open questions as debts. Search his own reading (Readwise) before the web. Never propose a thesis
up front; it emerges from the threads.
`,
};

const writing: Files = {
  'outline.md': `# Outline — {{project}}

The current shape of the piece, section by section. Each section names its state (idea, drafting,
ready), the threads it draws from and the quotes it will use.
`,
  'drafts/README.md': `# Drafts

Working drafts, one file per section or version (\`02-why-it-matters.md\`, \`02-why-it-matters-v2.md\`).
Variations sit side by side; Tejas picks. Nothing here is published until it moves to \`site/\`.
`,
  'passages/README.md': `# Passages

Finished passages Tejas has accepted, in reading order. The interface agent builds the published
presentation from these, the outline and the threads.
`,
  'voices/README.md': `# Voices

Writing voices this piece uses as co-writers (an author whose sentences Tejas wants to learn from,
such as Sarah Perry for the third-places essay). One file per voice: who, why, sample passages. The
\`writing-voices\` skill says how to brief and call one.
`,
  'site/README.md': `# Site

The published presentation layer: the piece as its own interface, with comments, built by the
interface agent (\`../agents/interface.md\`). Drafts become a narrative here by thnkr.ing's
thread-to-narrative rules, not by hand.
`,
  'agents/co-writer.md': `---
role: co-writer
starts: a fork of the research agent's session, never a session of its own
session: (the research agent's, forked per question)
---

# Co-writer — {{project}}

The co-writer is the research agent asked a side question: from a highlight or a "by the way"
question in thnkr.ing, fork the research agent's conversation so the answer carries the whole
context of the topic without adding to the main conversation. Suggest sentences as two or three
variations; when a voice in \`voices/\` is named, write in that voice.
`,
  'agents/interface.md': `---
role: interface
starts: a new session in this project, when the piece moves from threads to presentation
session:
---

# Interface agent — {{project}}

{{purpose}}

You build the published presentation of this piece in \`site/\`: each piece is its own medium. Read
\`outline.md\`, \`passages/\` and \`threads.md\` before building, so the interface carries the topic's
context. Use thnkr.ing's thread-to-narrative rules and its commenting so readers can respond. Tejas
directs it in plain words ("add this image here"); show changes, keep his words.
`,
};

const design: Files = {
  'designs/README.md': `# Designs

Sketches, mockups and prototypes, one folder per idea. Each names what it tries, what Tejas said
about it and what changed next. Documenting, collecting ideas, writing and publication live in the
rest of this project, as for any piece.
`,
};

const LAYERS: Record<ProjectTemplate, Files[]> = {
  brainstorm: [brainstorm],
  writing: [brainstorm, writing],
  design: [brainstorm, writing, design],
};

export function projectTemplate(value: unknown): ProjectTemplate | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !(PROJECT_TEMPLATES as readonly string[]).includes(value))
    throw new Error(`Choose a template: ${PROJECT_TEMPLATES.join(', ')}.`);
  return value as ProjectTemplate;
}

/** The template's files with the project's name and purpose filled in, keyed by relative path. */
export function templateFiles(template: ProjectTemplate, project: string, purpose: string): Files {
  const files: Files = {};
  for (const layer of LAYERS[template])
    for (const [path, text] of Object.entries(layer))
      files[path] = text.replaceAll('{{project}}', project).replaceAll('{{purpose}}', purpose);
  return files;
}

/** The section the project's AGENTS.md gains, so every agent working here knows the layout. */
export function templateAgentsSection(template: ProjectTemplate): string {
  const lines = [
    '',
    `## Project template: ${template}`,
    '',
    '- `threads.md` — shared working memory: his reactions verbatim, open questions, running lists.',
    '- `research/` — numbered research dossiers with sources and quotes.',
    '- `agents/` — this project\'s standing agents, one specification each; start and address them as `agents/README.md` says.',
  ];
  if (template !== 'brainstorm') lines.push(
    '- `outline.md`, `drafts/`, `passages/` — the piece from shape to accepted prose.',
    '- `voices/` — writing voices used as co-writers.',
    '- `site/` — the published presentation, built by the interface agent.',
  );
  if (template === 'design') lines.push('- `designs/` — sketches, mockups and prototypes.');
  return lines.join('\n') + '\n';
}
