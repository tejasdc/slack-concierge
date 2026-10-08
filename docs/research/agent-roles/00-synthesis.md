# Agent roles design: first synthesis (draft for conversation, NOT approved, nothing built)

Evidence files: 01 failure log · 02 Inbox transcripts · 03 current architecture · 04 nature and organizations ·
05 brain and JEPA/Jev · 06 agent practice · 07 his reading.

## The diagnosis in one paragraph
The Inbox holds two jobs that pull against each other. **Choosing** where something goes is a fast
classification. **Carrying** each conversation, meaning relaying, explaining and summarizing, needs deep
understanding, and an agent that understands everything starts deciding and doing. Every recurring failure
family comes from the carrying job: doing the work itself, retelling answers inaccurately, changing
foundations, and misfiling. Measured: worker returns were 59% of what the Inbox read from people and agents
(5.0M characters against 3.5M). It went through 12 compactions in 9 days, 5 of them in the worst 30 hours,
plus two hard context-overflow failures. One 2-hour stretch today ran ≥19 relay hops across 4 sessions. Its
rulebook grew from 4.5 KB to 51 KB in 9 days. Families that got only instructions (doing the work, retelling
unverified claims, wrong destination, foundations) kept recurring. Families that got structure
(duplicate/misfiled notices, lost worker results) stopped.

## Principles drawn from the research
1. A boundary that can be crossed by choice will be crossed. Cooperation across levels needs a structural
   suppressor (Michod; Clune et al. 2013; the lived evidence in file 01).
2. Specialization pays when switching roles inside one unit is costly. So separate processes, not separate
   modes of one process (Rueffler et al. 2012; Goldsby et al. 2012).
3. The selector does not execute. The basal ganglia pick one channel to release and cannot do the action
   themselves (Redgrave, Prescott & Gurney 1999). The prefrontal cortex biases other areas rather than doing
   their work (Miller & Cohen 2001).
4. Durable identity lives outside the volatile store. Role and knowledge sit in slow, consolidated structure,
   not in working memory (complementary learning systems: McClelland et al. 1995). An agent whose role lives
   in its transcript loses it at compaction.
5. Coordinate through a shared medium, not a central relay (stigmergy: Grassé; Heylighen). The ledger
   already is that medium.
6. Attenuate variety at the boundary. Don't add capacity to an overwhelmed regulator (Ashby; Beer).
7. After the award, the manager is not a party to execution. One mandatory closing report comes back
   (Contract Net, Smith 1980; handoffs in OpenAI's SDK and LangGraph swarm).
8. Operations and identity/policy are different systems (Beer, System 1 against System 5). Engelbart's
   A/B/C levels are doing the work, improving the work, and improving how improvement happens. Foundations
   are C-level, and they belong to him.
9. The mode of cognition should match the job. Escalate from the fast mode to the slow one by measured
   uncertainty (Daw, Niv & Dayan 2005). Routing is fast and schema-bounded (Jev is built exactly for this).
   Briefing and design are slow.
10. Augmentation requires that he can understand and reshape the system (Engelbart 1962; Kay).

## Candidate structure (for discussion)
- **Front door (selector).** Reads each capture plus the board (thread titles and statuses, session
  catalogue) and emits exactly one typed choice: continue thread X / send to session Y / new session in
  project Z / save as note / ask Tejas where. It has no free-text answer and no working tools, so it cannot
  answer or build. It is stateless per capture, so compaction cannot erase its role. It can be an LLM
  constrained to that schema or a Jev-style classifier with a fallback when uncertain.
- **Thread = direct line.** Once a thread is bound to a session, the worker's answers land in the thread in
  its own words, and his replies go straight to that worker. The front door sees only status (opened,
  waiting on you, done), never the content.
- **Brief = his exact words plus pointers.** No paraphrase. The worker reads the linked threads and captures
  itself. This removes retelling errors. The risk is thin briefs (Cognition), so it is an open question.
- **Board (shared medium).** Threads, requests, questions and outcomes already exist in the ledger. They
  become the only memory the front door uses.
- **Attention.** Driven by the worker's declared outcome in its own thread (already mandatory), not by a relay.
- **Overview (optional, slow).** Periodically reads the board, not transcripts, and tells him what is
  moving across threads. It is separate from the selector, so understanding everything never becomes doing.
- **Foundations.** Proposed changes to how the system works come to him as a proposal. Open question:
  should that be a record type he approves, or stay a human practice? Adding such a gate is itself a
  foundation change.

## Failure family → structural answer
A doing the work → selector has no answer channel · B retelling errors → no retelling; the worker speaks ·
C duplicate/misfiled → already structural, plus thread binding · D wrong destination → uncertain choices go
to "ask Tejas where", and a misroute is moved in one tap · E lost results → already structural · F
foundations → proposal path, to be decided · G over-forwarding and dictating mechanism → brief is verbatim ·
H rules lost in migration → role lives in the shape, not the text.

## Evaluation available without building
698 of his captures already have recorded destinations. Relabelling a sample gives a routing test set to
compare an LLM-schema selector with a classifier. Only on his approval.

## Honest limits
- No primary source describes this exact pattern. It is a design bet.
- The biology and brain findings are analogies. They diagnose why unenforced roles fail; the enforcement
  itself is software.
- Most citations were read through abstracts and secondary summaries. Verify any that carry weight.
- On September 22 he wanted the Inbox to take away the juggling of hundreds of sessions. Direct threads
  keep one inbox, but it needs checking against that.

---
## Revision 2 (after his reply, 2026-09-25): an interface problem, and the chief of staff keeps an index
His correction: a thin classifier loses what makes the Inbox valuable, which is expanding cryptic
messages and pointing workers at related sessions. The real mistake was that every thread reply went
through the Inbox. He prefers threads to the sidebar because the sidebar is overwhelming. He floated a
per-project chief of staff. Jev is parked because its sign-ups are paused.
New evidence: file 08 (hippocampal indexing, transactive memory, I-PASS, ATC transfer of control, 911
dispatch, M-form/VSM, the Galbraith ladder) and file 09 (sidebar: 303 shown, 202 Slack-era never
closed, 58 moved in 7 days; 83/91 agent-started sessions trace to his request; nothing links session to
thread; 111 of his messages already went straight to 28 worker sessions).
Revised shape: the Inbox keeps a directory (thread → owner, one line, status, related work), fed by the
workers' own status lines. It hands off once, with a structured packet, and the owner reads back its
understanding. After that, his thread replies go to the owner. The Inbox watches cheap per-thread
signals. The sidebar becomes his threads, with sessions nested under the thread that caused them. A
per-project coordinator is added only when a named symptom appears.
