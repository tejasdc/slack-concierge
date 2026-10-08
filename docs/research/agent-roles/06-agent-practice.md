# How others build router/worker agent systems (compiled from four research helpers' returns)

The research agent for this brief delegated to four helpers and stopped before writing its file; this
file compiles their returned findings. Full source lists are in the helpers' returns and are cited inline.

## Two camps on "who talks to the human"
- **Relay through the front door** (OpenAI agents-as-tools; LangGraph supervisor; Magentic-One; CrewAI
  hierarchical; Anthropic's Research feature; Claude Code subagents; Anthropic's Chief-of-Staff cookbook;
  commercial "AI chief of staff" products). The coordinator owns every answer. Context grows with every
  specialist result. LangGraph's own maintainers now discourage their packaged supervisor and have archived it.
- **Hand off control** (OpenAI Agents SDK handoffs, Swarm; LangGraph swarm). The router transfers the
  conversation and the specialist becomes the conversational partner. LangGraph swarm remembers the
  last-active agent, so the human's next message goes straight to it. OpenAI's guide: use handoffs when
  the specialist "should own the next response"; "customer service triage is a classic handoff use case".
- Anthropic's five coordination patterns: four funnel the human through one front door. **No primary
  source describes "router briefs, then human and a persistent worker talk directly in a thread."** It is
  a real design bet and not a known pattern. It is also not contradicted by anything found.

## Context degradation
- Anthropic, Effective context engineering (Sep 2025): "context rot" is a gradient. The fix is keeping
  noisy work out of the long-lived agent (sub-agent isolation, 1–2k-token returns), not better compaction.
  Compaction suits "tasks requiring extensive back-and-forth", which is exactly the traffic to move off the router.
- Magentic-One: the coordinator re-derives a small structured Task Ledger and Progress Ledger rather than trusting its transcript.
- Manus: the file system acts as external memory, and the agent recites its plan (todo.md) to fight goal drift. Tools are masked, not removed.
- 12-factor agents: contact humans with a structured tool call (F7), own the control flow (F8), keep agents
  small (F10, 3–20 steps), and treat the agent as a stateless reducer over external state (F12).
- MemGPT/Letta: memory changes only through validated function calls, and eviction is forced under memory
  pressure whether or not the model complies.
- asyncdot "Chief of Staff pattern" for Claude Code: "Long sessions get compacted … the summary loses the
  specifics." Its fix is durable briefs and a task board outside the conversation.

## Brief quality (the counter-argument)
- Cognition, "Don't Build Multi-Agents" (Jun 2025): share full context, because a task description alone
  loses implicit decisions (the Flappy Bird example).
- Cognition, "Multi-Agents: What's Actually Working" (2026): partially reversed. Writes stay single-threaded
  and read-only helpers add intelligence. A reviewer with *no* shared context caught the most bugs, because
  inherited context causes rot.

## Classic multi-agent theory
- Contract Net (Smith 1980): announce, bid, award, execute, report. After the award, the manager is not a
  party to execution, and the terminal inform/cancel report is mandatory. It is the closest fit; drop the bidding.
- FIPA ACL and speech acts: a closed vocabulary of message types, with refusal as a legal move. A router whose
  only legal act is a directive cannot "converse".
- Actor model: private state and mailboxes. The router should have no access to the worker-human exchange.
- Blackboard and Linda tuple spaces: coordination through a shared medium (stigmergy), with no direct channel.

## Routing as classification
- RouteLLM: small trained routers keep 95% of quality at 85% lower cost on MT-Bench.
- Embedding routers: 90–96% precision, ~100 ms against ~5 s, but weak on out-of-distribution and
  compositional intents. Production systems cascade (keywords, then embedding, then small model, then an LLM fallback).
  LLM tool-routing accuracy falls from 94% with 50 tools to 13.6% with 741.
- The literature covers *choosing a destination*, not *writing a brief*. The two jobs separate.

## Interruption
- Horvitz 1999: whether to interrupt is a per-item expected-utility decision (cost of interrupting against cost of deferring).
- Iqbal & Horvitz 2007 (secondary sources): resuming the original task takes 10–15 minutes. Interrupt at breakpoints.
