# Project templates: brainstorming, writing and design projects with their agents built in

Tejas, 2026-10-29 (to session mac:75): "we should be able to go and start a brainstorming project or a
design project. The design project should come with these basic strings baked in. So we've got to
start defining templates here. And one of the templates here is a folder for custom agent
specification … a research agent and then a fork session for like co-writing as well as … by the way
… questions and then interface agent when we want to start publishing and … move from the thread
layer to a presentation layer."

## What is built

`project new <name> --owner tejas --purpose "…" --template brainstorm|writing|design` lays a
template into the new project before its first commit, so the project's private GitHub repository,
and the Mac's copy cloned from it, start with the same folders. The templates live in one place,
`bot/src/project-templates.ts`, shipped inside the release; each extends the previous one:

| Template | Adds |
| --- | --- |
| brainstorm | `threads.md` (his reactions verbatim, open questions, running lists), `research/` (numbered dossiers), `agents/README.md`, `agents/research.md` |
| writing | `outline.md`, `drafts/`, `passages/`, `voices/` (writing voices used as co-writers), `site/` (the published presentation), `agents/co-writer.md`, `agents/interface.md` |
| design | `designs/` (sketches, mockups, prototypes) |

The layout is the third-places essay workspace on his Mac (`~/workspace/blogs/third-spaces-online`):
threads file, numbered research dossiers, outline, drafts, passages and a Sarah Perry voice. The
project's `AGENTS.md` gains a section naming each folder, so every agent working there knows it.

## The agents folder

Each `agents/<role>.md` is one standing agent: what it owns, how it starts, and a `session:` line
holding its address once started.

- **Research agent**: a new session in the project; owns the research and keeps the threads file.
- **Co-writer**: not a session of its own. It is the research agent asked a side question, a fork
  of its conversation from a highlight or a "by the way" question in thnkr.ing, so the answer has
  the topic's whole context without adding to the main conversation.
- **Interface agent**: a new session when the piece moves from threads to presentation; builds
  `site/` with the topic's context, using thnkr.ing's thread-to-narrative rules and commenting.

## Choices and why

- A writing or design project is its own repository, not a folder inside the `blogs` workspace,
  because each piece grows its own published interface (code) and must exist on both machines;
  `blogs` stays for lightweight notes. The third-places essay is not moved.
- One template file with layers, not three copies, so a change to the threads format happens once.
- Agents start through the existing `sessions ask --project <name>` with the spec as instructions,
  rather than a new launcher, until starting them by hand proves to be the friction.

## Next

- A starter, `project agent <project> <role>`, that starts the agent from its spec the first time,
  records its address, and continues it after that, so no agent has to remember the `session:` line.
- The narrative view and presentation library belong to the Explanations session in thinkering;
  `site/` is where that work lands per project.
