# Prompt injection, personal agents, and walling off money and identity — research notes

Researched 2026-10-07 for a security review of Tejas's agent system. Reading only; nothing was changed or contacted.
Marking: **[V]** = I read the primary source. **[S]** = secondary source only (primary blocked or not found). **[U]** = could not verify.
OpenAI's own pages (openai.com, help.openai.com) returned HTTP 403 to every fetch, so the OpenAI items rely on secondary reporting plus OpenAI's developer docs, which did load.

---

## 1. OpenClaw (formerly Clawdbot → Moltbot), late 2025 – 2026

**Timeline of incidents**

| Date | What happened | Source |
|---|---|---|
| 2026-01-26 | SlowMist: hundreds of Clawdbot gateways exposed with API keys, OAuth tokens and chat history, no auth. O'Reilly's Shodan scan: 8 fully open with command execution. Root cause: the gateway auto-trusted "localhost", and reverse proxies made internet traffic look local. Credentials sat in plaintext in `~/.clawdbot/`; RedLine, Lumma and Vidar infostealers added it as a target. (Renamed to Moltbot 2026-01-27, then OpenClaw.) | [VentureBeat](https://venturebeat.com/security/clawdbot-exploits-48-hours-what-broke) [S] |
| late Jan 2026 | **Email injection demo:** Matvey Kukuy emailed an instance a prompt injection, asked it to check mail, and got the host's SSH private key back "in five minutes flat". | same [S]; original post not found [U] |
| 2026-01-30 | **CVE-2026-25253 (CVSS 8.8), one-click RCE:** the Control UI took `gatewayUrl` from the link and sent the gateway token there; the attacker could then "modify config (sandbox, tool policies)". Fixed 2026.1.29. | [The Hacker News](https://thehackernews.com/2026/02/openclaw-bug-enables-one-click-remote.html) [S] |
| 2026-02-02 | **ClawHavoc (Koi):** 341 of 2,857 ClawHub skills malicious; 335 used fake "prerequisite" shell commands to install Atomic macOS Stealer (keychain, browser credentials, crypto wallets). 824 of 10,700+ by 2026-02-16. Response: reporting, auto-hide after 3 reports, publisher GitHub accounts ≥1 week old. | [The Hacker News](https://thehackernews.com/2026/02/researchers-find-341-malicious-clawhub.html) [V] |
| 2026-02-04 | **Zenity "OpenClaw or OpenDoor":** an injection in a Google Doc makes the agent add an attacker's Telegram bot, rewrite `SOUL.md` (always-loaded identity file) and schedule re-injection; it survives restarts. "No hard separation between what the user explicitly asked… and what the agent reads." | [Zenity Labs](https://labs.zenity.io/p/openclaw-or-opendoor-indirect-prompt-injection-makes-openclaw-vulnerable-to-backdoors-and-much-more) [V] |
| early Feb 2026 | **Moltbook** database open: 1.5M agent API tokens, 35,000 emails, private messages. | [Wiz](https://wiz.io/blog/exposed-moltbook-database-reveals-millions-of-api-keys) [S] |
| 2026-02-07 | **VirusTotal scanning** of every ClawHub skill, re-scanned daily. Admits: "A carefully crafted prompt injection payload won't show up in a threat database." Promised a threat model, roadmap, code audit and reporting SLA. | [openclaw.ai](https://openclaw.ai/blog/virustotal-partnership) [V] |
| 2026-02-09 | **SecurityScorecard:** 135,000+ exposed instances, 50,000+ vulnerable to a known RCE; it listened on all interfaces by default. | [The Register](https://theregister.com/2026/02/09/openclaw_instances_exposed_vibe_code) [S] |
| Feb 2026 | **Zero-click exfiltration via link previews (PromptArmor):** the injected agent writes a URL containing secrets, and Telegram/Slack/Discord fetch it to build a preview. Hit OpenClaw's default Telegram setup. | [PromptArmor](https://www.promptarmor.com/resources/llm-data-exfiltration-via-url-previews-(with-openclaw-example-and-test)) [S] |
| 2026-03-13 | **CVE-2026-32922 (CVSS 9.9):** a paired device could mint an admin token, leading to RCE. Fixed 2026.3.11. | [NVD](https://nvd.nist.gov/vuln/detail/CVE-2026-32922) [S] |
| 2026-06-13 | CSA note recommends: disable link previews, keep ports off the internet, integrity-monitor `SOUL.md`/`MEMORY.md`, allow-list outbound connections. | [CSA Labs](https://labs.cloudsecurityalliance.org/research/csa-research-note-openclaw-indirect-prompt-injection/) [V] |
| 2026-10-07 | Running total: 212 project advisories (1 critical, 109 high) and 543 CVEs that name OpenClaw. | [jgamblin/OpenClawCVEs](https://github.com/jgamblin/OpenClawCVEs) [V] |

**Current OpenClaw guidance** ([docs](https://docs.openclaw.ai/gateway/security) [V]):
- One trust boundary per gateway ("a single operator, or a team whose members trust each other").
- Bind to loopback, with Tailscale Serve for remote access.
- Token auth for any non-loopback bind.
- DM pairing, so unknown senders never reach the agent.
- Per-agent tool profiles and sandboxing.
- `openclaw security audit` to check for drift.

NVIDIA's [NemoClaw](https://github.com/NVIDIA/NemoClaw) wraps OpenClaw in Landlock, seccomp and network-namespace isolation.

**The lesson.** Most of the damage came from ordinary security bugs: exposed ports, trusted-localhost, token leaks and an unvetted marketplace. Prompt injection made each one worse. Every fix was a system-level boundary (bind, auth, pairing, scanning, sandbox). None of them was a better prompt.

---

## 2. Simon Willison: the lethal trifecta and related writing

- **Lethal trifecta** ([2025-06-16](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/) [V]): **private data + untrusted content + external communication** together let an attacker steal the data. A guardrail that stops 95% of attacks "is very much a failing grade". Once users mix MCP tools themselves, no vendor can protect them; the fix is to "avoid that lethal trifecta combination entirely".
- **Dual LLM** ([2023-04-25](https://simonwillison.net/2023/Apr/25/dual-llm-pattern/) [V]):
  - A privileged LLM holds the tools and sees only trusted input. A quarantined LLM reads untrusted text and has no tools.
  - A controller passes the quarantined model's results around as opaque variables (`$VAR1`).
  - Weaknesses he names: an attacker can still talk the *user* into leaking data, and every chained model call needs isolation.
- **Design Patterns paper** (Beurer-Kellner et al., IBM/Invariant/ETH/Google/Microsoft, [arXiv 2506.08837](https://arxiv.org/abs/2506.08837); [Simon's summary](https://simonwillison.net/2025/Jun/13/prompt-injection-design-patterns/) [V]):
  - Its rule: "once an LLM agent has ingested untrusted input, it must be constrained so that it is *impossible* for that input to trigger any consequential actions."
  - Six patterns:
    - **Action-Selector:** the model picks from fixed actions and never sees their output.
    - **Plan-Then-Execute:** tool calls are fixed before any untrusted content is read.
    - **LLM Map-Reduce:** isolated sub-agents each handle one untrusted item.
    - **Dual LLM.**
    - **Code-Then-Execute:** the CaMeL approach.
    - **Context-Minimization.**
  - The authors trade general capability for guarantees.
- **Rule of Two and the adaptive-attack paper** ([Simon, 2025-11-02](https://simonwillison.net/2025/Nov/2/new-prompt-injection-papers/) [V]):
  - Meta's "Agents Rule of Two" (2025-10-31): in one session, at most two of untrusted input, sensitive data/systems, and state change or external communication.
  - "The Attacker Moves Second" (OpenAI, Anthropic and DeepMind authors): adaptive attacks beat 12 published defenses, mostly at more than 90% success, and human red-teamers beat 100%.
  - Simon calls the Rule of Two "the best practical advice" available today.

---

## 3. CaMeL (Google DeepMind / ETH), and what dual-LLM designs cost

- **Mechanism** ([arXiv 2503.18813](https://arxiv.org/abs/2503.18813) [V]; [Simon, 2025-04-11](https://simonwillison.net/2025/Apr/11/camel/) [V]):
  - A privileged LLM turns the request into restricted Python *before* any untrusted data is seen, so the attacker cannot change the plan.
  - A quarantined LLM parses untrusted content and has no tools.
  - An interpreter tags every value with **capabilities** (where it came from, who may read it) and checks a policy before each tool call. My own example of such a policy: an email recipient must come from the user, never from an email body.
- **What it buys:** 77% of AgentDojo tasks solved with *provable* security, against 84% undefended. Simon calls it "the first credible prompt injection mitigation I've seen that *doesn't* just throw more AI at the problem".
- **What it costs:**
  - About 7 points of task success.
  - **2.82× input and 2.73× output tokens** for the median task ([paper PDF](https://arxiv.org/pdf/2503.18813) [S, via search excerpt]).
  - Someone has to write and maintain the policies, and the approval prompts tire users into clicking yes.
  - It guards control and data flow, not whether a quarantined summary is *true*. [U: my reading of the threat model]
- **For one person:** skip the interpreter and keep the cheap core. Deterministic code, not the model, decides where data may flow.

---

## 4. Vendor guidance

### Anthropic
- **Claude Code** ([security docs](https://code.claude.com/docs/en/security) [V]): Manual mode fails closed and never auto-approves `curl`/`wget`; WebFetch gives Claude a separate model's summary, not the raw page; trust and `.mcp.json` prompts are **skipped in `-p` runs**; advice is to use VMs when touching external services.
- **Permission modes** ([docs](https://code.claude.com/docs/en/permission-modes) [V]): `default`, `acceptEdits`, `plan`, `auto`, `dontAsk`, `bypassPermissions`.
  - **"`bypassPermissions` offers no protection against prompt injection or unintended actions"**; it is for containers and VMs only, run as a non-root user.
  - **Auto mode**'s classifier blocks by default: sensitive data sent to external endpoints, printing live credentials, Chrome actions that send cookies or credentials off-origin, pushes to third-party repos, and anything Tejas has ruled out in the conversation ("don't push").
- **Sandboxing** ([2025-10-20](https://www.anthropic.com/engineering/claude-code-sandboxing) [V]): filesystem and network isolation together ("Without network isolation, a compromised agent could exfiltrate sensitive files like SSH keys…"), a proxy that allow-lists domains, and 84% fewer permission prompts.
- **Managed Agents** ([2026-04-08](https://www.anthropic.com/engineering/managed-agents) [V]): "a prompt injection only had to convince Claude to read its own environment"; narrow token scopes "encode an assumption about what Claude can't do with a limited token". Their fix: tokens **never reachable from the sandbox**, held in a vault and attached by a proxy.
- **Claude for Chrome** ([2025-08-25](https://claude.com/blog/claude-for-chrome) [V]):
  - Attack success fell from 23.6% to 11.2%, and browser-specific attacks from 35.7% to 0%. The example attack was a fake "mailbox hygiene" email telling Claude to delete mail.
  - Defenses: per-site permissions, confirmation before publishing, purchasing or sharing data, **financial-services sites blocked by default**, and classifiers.
- **Browser research** ([Anthropic](https://www.anthropic.com/research/prompt-injection-defenses) [V]): Opus 4.5 had a **1%** attack success rate against an adaptive Best-of-N attacker given 100 attempts. Defenses are RL training, classifiers and red-teaming. "No browser agent is immune to prompt injection."
- **Opus 5 system card** (July 2026; [The Decoder](https://the-decoder.com/opus-5-may-have-solved-browser-based-prompt-injection-the-biggest-security-flaw-haunting-ai-agents/) [S], [PDF](https://www-cdn.anthropic.com/c5fbac3f0b1280a933ebd26d3cb8bb9f5bdeaf48/Claude%20Opus%205%20System%20Card.pdf#page=76) not opened by me):
  - 0% over 129 browser scenarios, *only* with Auto Mode's input scanning and action blocking both on; 3.7% without them.
  - Gray Swan benchmark: 2.0% after 15 attempts.

### OpenAI
- **ChatGPT agent** (2025-07-17; [SD Times](https://sdtimes.com/ai/chatgpt-now-has-an-agent-mode/), [help article](https://help.openai.com/en/articles/11752874-chatgpt-agent) [S; primary 403]):
  - Asks for confirmation before consequential actions.
  - **Watch mode** on email and finance sites.
  - Refuses **bank transfers**.
  - Hands logins and payments back to the user (takeover mode) and does not store passwords typed there.
  - Memory disabled at launch.
- **Atlas hardening** (2025-12-22; [primary](https://openai.com/index/hardening-atlas-against-prompt-injection) 403, [The Decoder](https://the-decoder.com/openai-admits-prompt-injection-may-never-be-fully-solved-casting-doubt-on-the-agentic-ai-vision/) [S]): an RL-trained attacker finds injections in simulation; OpenAI concedes prompt injection, like scams, may never be "fully solved".
- **AgentKit safety guide** ([developers.openai.com](https://developers.openai.com/api/docs/guides/agent-builder-safety) [V]):
  - Never put untrusted text in developer messages.
  - Use structured outputs between steps to "eliminate freeform channels that attackers can exploit to smuggle instructions or data".
  - "When using MCP tools, always enable tool approvals… including reads and writes."
  - Add PII and jailbreak guardrails, which are model-based and bypassable ([Zenity](https://labs.zenity.io/p/breaking-down-agentkit-s-guardrails) [S]).

### Email-agent attacks most like Tejas's setup
- **EchoLeak** (CVE-2025-32711, CVSS 9.3, June 2025): one email made M365 Copilot leak data with no click, getting past Microsoft's injection classifier and link redaction ([arXiv](https://arxiv.org/html/2509.10540v1) [S]).
- **ShadowLeak** (Radware; reported 2025-06-18, fixed Aug 2025): hidden email text made ChatGPT Deep Research send Gmail data out from OpenAI's own servers ([Radware](https://www.radware.com/blog/posts/shadowleak/) [S]).

---

## 5. Patterns that shipping systems use

| Pattern | What it is / evidence |
|---|---|
| **Capability-scoped tools** | Narrowest OAuth scope. Gmail's `gmail.send` is a separate, lower scope than the "restricted" `gmail.readonly`/`gmail.modify`/full-mail scopes ([Google scopes](https://developers.google.com/workspace/gmail/api/auth/scopes) [S]). OWASP LLM06 "Excessive Agency": least privilege, task-specific accounts, human approval for financial and destructive operations ([summary](https://www.indusface.com/learning/owasp-llm06-excessive-agency/) [S]). |
| **Credentials outside the agent** | Vault plus proxy, with no tokens in the sandbox ([Anthropic Managed Agents](https://www.anthropic.com/engineering/managed-agents) [V]). Jim Clark (Docker), on how many credentials a sandbox should hold: "the right answer is always zero" ([talk](https://ai.engineer/talks/ZUZVNKFSmTM-many-credentials-should-your-ai-agent-have)). |
| **Recipient allow-lists / data-flow rules** | CaMeL policies ([paper](https://arxiv.org/abs/2503.18813)). Claude auto mode blocks sensitive data going to unconfigured external endpoints ([docs](https://code.claude.com/docs/en/permission-modes) [V]). |
| **Human confirmation for outbound/irreversible actions** | Claude for Chrome (publish, purchase, share), ChatGPT agent (confirmations, takeover for payments), OpenAI's "approve every MCP read and write". Simon and the CaMeL paper both warn about approval fatigue. |
| **Block categories outright** | Claude for Chrome blocks financial-services sites by default; ChatGPT agent refuses bank transfers. |
| **Egress control** | Sandbox network allow-list ([Anthropic](https://www.anthropic.com/engineering/claude-code-sandboxing) [V]). Disable link previews in agent chat channels ([PromptArmor](https://www.promptarmor.com/resources/llm-data-exfiltration-via-url-previews-(with-openclaw-example-and-test)), [CSA](https://labs.cloudsecurityalliance.org/research/csa-research-note-openclaw-indirect-prompt-injection/)). |
| **Taint tracking** | CaMeL capabilities; Dual-LLM opaque variables. I could verify no consumer agent that ships it. [U] |
| **Redacting OTP / password-reset mail before the agent sees it** | **No shipping product found that does exactly this.** [U] Closest: OpenAI's PII guardrails (pattern-based, bypassable). Simple to build deterministically at the email/SMS ingestion layer (sender and subject rules plus a code pattern). |
| **Separate identity for money accounts** | Bank, brokerage and crypto logins on an email address and phone number no agent is connected to, so their resets and codes never reach an agent. Follows from the trifecta and Rule of Two; my own inference, no single canonical source. |
| **Phishing-resistant MFA** | CISA (Dec 2024): "Do not use SMS as a second factor"; FIDO is "the strongest form of MFA", and passkeys are acceptable ([CISA PDF](https://cisa.gov/sites/default/files/2024-12/guidance-mobile-communications-best-practices.pdf) [S]). Why it matters here: a passkey or security key produces nothing an agent can read and forward. |
| **Google Advanced Protection** | Requires a passkey or security key to sign in; "allows only Google apps and verified third-party apps to access your Google Account data" ([Google](https://landing.google.com/intl/en_in/advancedprotection/) [V]). **Caveat:** it may block an unverified self-built OAuth app's Gmail access, so test it against the agents' own Google sign-in before enrolling the agent-connected account. |
| **SIM-swap protection** | FCC rules (effective 2024-01-08, compliance deadline waived until OMB review) require carriers to authenticate before a SIM change or port-out and to notify the customer ([Federal Register](https://www.govinfo.gov/content/pkg/FR-2023-12-08/html/2023-26338.htm) [S]). Per-carrier locks: AT&T Wireless Account Lock; Verizon Number Lock + SIM Protection; T-Mobile SIM Protection **and** Account Takeover Protection (both are needed) ([Techlicious](https://www.techlicious.com/tip/lock-sim-card-sim-swapping/) [S]). |
| **Audit logs / alerts** | Claude Code cloud sessions log every operation; usage can be monitored through OpenTelemetry ([docs](https://code.claude.com/docs/en/security) [V]). CSA recommends file-integrity monitoring on agent identity and memory files. Tailscale's Aperture logs every model request per identity ([talk](https://ai.engineer/talks/BM2JX9hqsVQ-what-if-network-was-sandbox)). |

---

## 6. AI Engineer talks (from `ai-engineer-talks search`) and Tejas's Readwise

**Talks**
- [Erik Meijer, "I've never seen anything scarier than an LLM with tool calls" (WF 2026)](https://ai.engineer/talks/-CnA2lGfymY-ive-never-seen-anything-scarier-than-llm): agents should *propose* effects and a checked, air-gapped executor should apply them; formal verification is his answer to prompt injection.
- [Jim Clark (Docker), "How Many Credentials Should Your AI Agent Have? Zero." (WF 2026)](https://ai.engineer/talks/ZUZVNKFSmTM-many-credentials-should-your-ai-agent-have): keep credentials outside the sandbox, at the MCP/gateway layer; Cross App Access (XAA).
- [Remy Guercio (Tailscale), "What if the network was the sandbox?" (Europe 2026)](https://ai.engineer/talks/BM2JX9hqsVQ-what-if-network-was-sandbox): separate execution isolation from credential control; an identity-aware gateway on the tailnet logs every request. Directly relevant, since Tejas already uses Tailscale.
- [Christopher Lovejoy (Anthropic) & Saul Howard, enterprise stack (WF 2026)](https://ai.engineer/talks/mav15aW9lLM-why-your-enterprise-tech-stack-isnt-ready): avoid the trifecta by architecture; agents get data at the point of use with bearer tokens, never by letting it flow freely.
- [Michael Hablich (Chrome DevTools MCP, Europe 2026)](https://ai.engineer/talks/_B4Pv9ttFgY-building-agent-interfaces-lessons-from-chrome): when all three trifecta legs meet, "the human actually need to consent every time".
- [Šimon Podhajský, "Read-Only AI Is Underrated" (Europe 2026)](https://ai.engineer/talks/u0TOSBbAw7c-cognitive-exhaust-fumes-read-only-ai-is): a personal agent with read-only access to six data sources, writing only to an isolated workspace, which removes the trifecta's external-communication leg.
- Also relevant: [Kitsch & Kakkar (Google)](https://ai.engineer/talks/9R--1tg45Jg-build-time-vs-run-time-why-dev): narrow tools where the application, not the model, sets identity. [Fouad Matin (OpenAI)](https://ai.engineer/talks/w7IMuYsBNr8-safety-security-code-executing-agents): containers, restricted internet, human review. [Rene Brandel (Casco)](https://ai.engineer/talks/kv-QAuKWllQ-we-hacked-yc-spring-2025-batchs-ai): "agent security is bigger than just LLM security".

**Tejas's Readwise.** Highlights: nothing relevant. Reader documents he has saved:
- Anthropic's [Scaling Managed Agents](https://read.readwise.io/read/01knr94a5xajcxkbz8jrpfpzmp), Simon's [Designing agentic loops](https://read.readwise.io/read/01k7g0rm6vhcz3j4azc4kwyzg7) and [NVIDIA NemoClaw](https://read.readwise.io/read/01kkwrbgvk7f22s59g2fgfss9n).
- Mario Zechner's [minimal coding agent](https://read.readwise.io/read/01kfj91z78ts6k7bp2vfxwn74g): per-command checks are "mostly security theater… The only way you could prevent exfiltration of data would be to cut off all network access".
- ["Field Report: The Harness Is the Product"](https://read.readwise.io/read/01kkn0z768tk0n96mt7fmxjm7f): agents as a confused-deputy problem.
- Andy Berman's "OpenClaw for Enterprise" claims "91% of prompt injection attacks successfully one-shot OpenClaw". Vendor marketing figure. [U]

---

## What this means for a single-person system like Tejas's

1. **Today his system has all three trifecta legs in one context.** Agents read his Gmail and texts (private data), the same mail and web pages carry attacker text (untrusted content), and they can send email and reach the network (external communication). Every source above agrees: once that combination exists, prompt filtering alone fails. Adaptive attackers beat 12 of 12 published defenses more than 90% of the time.
2. **Codex agents here run with no approval checks at all, and Claude agents may too.** Confirmed in this repository: Codex runs with `approvalPolicy: "never"` and `sandbox: "danger-full-access"` (`bot/src/codex.ts:482-490`). Claude gets `--dangerously-skip-permissions` when `CONCIERGE_CLAUDE_CODE_SKIP_PERMISSIONS=1` (`bot/src/claude-code.ts:373`); I did not check whether that variable is set in production. Agents run as root on the server. Anthropic says plainly that this mode "offers no protection against prompt injection". The protection therefore has to come from what an agent can *reach*, not from asking it to be careful.
3. **The strongest single move is to take money and identity out of the agents' reach (leg B).** Put bank, card, brokerage and crypto logins and their recovery on a separate email address, and ideally a separate phone number, that no agent is connected to. Then an injected "send me the code" finds no code to send. Nothing else listed here does as much for that particular fear.
4. **For accounts that have to stay connected, filter before the model reads anything.** Drop or mask one-time codes, password-reset mail and bank alerts in the Gmail/SMS ingestion code (sender, subject and code patterns), so they never enter an agent's context. No product I found ships this, so it would be built here as deterministic code, not as a model judgment.
5. **Switch money accounts to passkeys or hardware keys, away from SMS and email codes.** A passkey produces nothing an agent can read and forward. CISA says not to use SMS as a second factor. Enroll Google Advanced Protection on the money-recovery account. Test it before enrolling the agent-connected Gmail, because it can block an unverified app's Gmail access.
6. **Lock the phone number.** Turn on the carrier's port-out and SIM locks (T-Mobile needs both SIM Protection *and* Account Takeover Protection). An agent compromise combined with a SIM swap is the worst case for SMS codes.
7. **Make outbound actions deterministic.** One sending service, outside the agents' sandbox, that enforces: recipients on an allow-list or explicitly named by Tejas; a structured payload; one tap from him for any new recipient or any attachment or body that came from mail it read. This is the CaMeL idea applied at its cheapest point. The existing tap-to-send for iMessage is already this pattern; email should match it.
8. **Keep credentials out of agent processes.** Use a vault plus proxy (Anthropic Managed Agents, Docker's "zero credentials"): Gmail and other tokens are attached by a proxy, so an injected `cat ~/.config/...` gets nothing. Root plus readable token files is the OpenClaw plaintext-credential failure.
9. **Close the exfiltration channels people forget.** Turn off link previews in any chat surface where agents post (the PromptArmor zero-click attack), don't auto-render remote images or Markdown links in agent output (EchoLeak), and allow-list outbound network traffic for sessions that read untrusted mail.
10. **Split sessions by Rule of Two rather than adding confirmations everywhere.** A session that reads inbound mail or web pages can't send or use money-adjacent tools. A session that sends works only from Tejas's own words plus quarantined summaries. Approval fatigue is the documented failure mode of confirming everything.
11. **Treat skills, MCP servers and agent instruction files as code that can carry an injection.** ClawHavoc grew from 341 to 824+ malicious skills, and SOUL.md poisoning persisted through restarts. Changes to instruction and memory files should be audited and alerted, which the existing single Git-backed skills catalogue already partly does.
12. **Alert on account-level signals no agent can suppress.** Bank and card transaction alerts, Google security alerts and carrier port/SIM notices should go to a channel agents can't read or delete. Log every outbound send with the session that caused it.
