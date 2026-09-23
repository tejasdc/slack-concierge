import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { PROVIDER_ALIASES, type ProviderAliasKey } from "./aliases";
import { db, executionChanged, getSessionById, type ProviderId } from "./state";
import { log } from "./log";
import { inboxSession } from "./session-inbox";

/**
 * A provider outage, told to Tejas once per stuck message with the choices that can
 * actually answer right now (his decision of 2026-09-22, after Anthropic's incident held
 * an Inbox message for 19 minutes).
 *
 * Detection is the provider's own error (overloaded, 5xx, rate limit) persisting past the
 * CLI's first quick retries, confirmed where possible by the provider's status page. An
 * outage can take several models down at once, so every alternative is checked with a
 * tiny real request before it is offered; nothing switches without his tap, and a model
 * he picked for a session is never changed.
 */

export interface ProviderIncident { name: string; url: string | null; updatedAt: string | null }
export interface OutageAlternative { alias: ProviderAliasKey; label: string; provider: ProviderId; model: string }
export interface OutageOffer {
  turnId: number; inputId: string; sessionId: number; provider: ProviderId; model: string | null;
  status: number | null; incident: ProviderIncident | null; alternatives: OutageAlternative[];
  offeredAt: string; choice: string | null; chosenAt: string | null; rerunSessionId: string | null;
}

// The alternatives worth offering: the other Claude models that can do real work, and
// Codex's quality tier. Astra is never offered: its credits need an explicit choice.
const CANDIDATES: readonly ProviderAliasKey[] = ["cc-opus", "cc-sonnet", "cc-fable", "cx-sol"];
// Claude Opus 5 keeps its own label: sessions started before Opus 5.5 still run on
// it, and a person reading the notice should see the model their session is using.
const LABELS: Record<string, string> = {
  "claude-opus-5-5": "Claude Opus 5.5", "claude-opus-5": "Claude Opus 5", "opus[1m]": "Claude Opus 5.5",
  "claude-sonnet-5": "Claude Sonnet 5",
  "claude-fable-5-1": "Claude Fable 5.1", "claude-haiku-4-5-20251001": "Claude Haiku 4.5", "gpt-5.6-sol": "GPT-5.6 Sol",
};
export const modelLabel = (model: string | null) => (model && LABELS[model]) || model || "the selected model";
const family = (model: string | null) => (model ?? "").replace(/\[1m\]$/, "").replace(/^opus$/, "claude-opus-5-5");

/** Trouble on the provider's side, from its status code or the CLI's error text. */
export function providerTroubleStatus(text: string): number | null {
  const code = Number(text.match(/\bAPI Error:\s*(\d{3})\b/)?.[1]);
  if (code === 429 || code === 529 || (code >= 500 && code < 600)) return code;
  if (/overloaded/i.test(text)) return 529;
  if (/internal server error/i.test(text)) return 500;
  return null;
}

const INCIDENT_TTL_MS = 60_000;
let incidentCache: { at: number; incidents: ProviderIncident[] } | null = null;
/**
 * Claude's open incidents from status.claude.com. OpenAI's status page has no stable JSON
 * feed, so a Codex outage is told from its errors and the live check alone.
 */
async function claudeIncidents(): Promise<ProviderIncident[]> {
  if (incidentCache && Date.now() - incidentCache.at < INCIDENT_TTL_MS) return incidentCache.incidents;
  try {
    const response = await fetch("https://status.claude.com/api/v2/incidents/unresolved.json", { signal: AbortSignal.timeout(8_000) });
    const body = await response.json() as { incidents?: any[] };
    const incidents = (body.incidents ?? []).map(incident => ({ name: String(incident.name ?? "Claude incident"),
      url: typeof incident.shortlink === "string" ? incident.shortlink : null, updatedAt: typeof incident.updated_at === "string" ? incident.updated_at : null,
      text: [incident.name, ...(incident.incident_updates ?? []).map((update: any) => update.body)].join(" ") }));
    incidentCache = { at: Date.now(), incidents: incidents as any };
    return incidents as any;
  } catch (error) {
    log("warn", "provider_status_unavailable", { provider: "claude-code", error: error instanceof Error ? error.message : String(error) });
    return [];
  }
}

/** The open incident that covers this model, or one that names no model at all. */
export async function incidentFor(provider: ProviderId, model: string | null): Promise<ProviderIncident | null> {
  if (provider !== "claude-code") return null;
  const incidents = await claudeIncidents() as (ProviderIncident & { text?: string })[];
  const name = modelLabel(family(model)).replace(/^Claude /, "");
  const named = incidents.find(incident => incident.text?.includes(name));
  const general = incidents.find(incident => !/\b(Opus|Sonnet|Fable|Haiku|Mythos)\b/.test(incident.text ?? ""));
  const found = named ?? general ?? null;
  return found ? { name: found.name, url: found.url, updatedAt: found.updatedAt } : null;
}

const PROBE_TTL_MS = 3 * 60_000;
const probeCache = new Map<string, { at: number; ok: boolean }>();
function run(command: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string }> {
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd: tmpdir(), stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, IS_SANDBOX: "1" } });
    let stdout = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.on("error", () => { clearTimeout(timer); resolve({ code: null, stdout }); });
    child.on("close", code => { clearTimeout(timer); resolve({ code, stdout }); });
  });
}
/** One tiny real request: the only honest answer to "is this model answering right now". */
async function probe(alternative: OutageAlternative): Promise<boolean> {
  const cached = probeCache.get(alternative.alias);
  if (cached && Date.now() - cached.at < PROBE_TTL_MS) return cached.ok;
  const started = Date.now();
  const result = alternative.provider === "claude-code"
    ? await run(process.env.CONCIERGE_CLAUDE_CODE_EXECUTABLE || "claude", ["-p", "--model", alternative.model, "--no-session-persistence",
        "--output-format", "json", "Reply with the single word OK."], 60_000)
    : await run(process.env.CONCIERGE_CODEX_EXECUTABLE || "codex", ["-s", "read-only", "-a", "never", "exec", "--skip-git-repo-check",
        "-m", alternative.model, "Reply with the single word OK."], 90_000);
  let ok = result.code === 0;
  if (ok && alternative.provider === "claude-code") {
    try { ok = JSON.parse(result.stdout).is_error !== true; } catch { ok = false; }
  }
  probeCache.set(alternative.alias, { at: Date.now(), ok });
  log("info", "provider_alternative_checked", { alias: alternative.alias, ok, duration_ms: Date.now() - started });
  return ok;
}

/** Alternatives to the troubled model that answered a live check just now. */
export async function verifiedAlternatives(provider: ProviderId, model: string | null, sameProviderOnly: boolean): Promise<OutageAlternative[]> {
  const candidates = CANDIDATES.map(alias => ({ alias, provider: PROVIDER_ALIASES[alias].provider as ProviderId,
    model: PROVIDER_ALIASES[alias].model!, label: modelLabel(PROVIDER_ALIASES[alias].model!) }))
    .filter(candidate => family(candidate.model) !== family(model) && (!sameProviderOnly || candidate.provider === provider));
  const checked = await Promise.all(candidates.map(async candidate => (await probe(candidate)) ? candidate : null));
  return checked.filter((candidate): candidate is OutageAlternative => !!candidate);
}

db.run(`CREATE TABLE IF NOT EXISTS provider_outage_offers (
  turn_id INTEGER PRIMARY KEY REFERENCES turns(id) ON DELETE CASCADE,
  input_id TEXT NOT NULL,
  session_id INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  choice TEXT,
  chosen_at TEXT,
  rerun_session_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`);

function offerFromRow(row: any): OutageOffer {
  const payload = JSON.parse(row.payload_json);
  return { ...payload, choice: row.choice ?? null, chosenAt: row.chosen_at ?? null, rerunSessionId: row.rerun_session_id ?? null };
}
export function outageOfferForTurn(turnId: number): OutageOffer | null {
  const row = db.query("SELECT * FROM provider_outage_offers WHERE turn_id=?").get(turnId);
  return row ? offerFromRow(row) : null;
}
export function recordOutageChoice(turnId: number, choice: string, rerunSessionId: string | null) {
  const changed = db.query("UPDATE provider_outage_offers SET choice=?,chosen_at=?,rerun_session_id=? WHERE turn_id=? AND choice IS NULL")
    .run(choice, new Date().toISOString(), rerunSessionId, turnId).changes === 1;
  if (changed) executionChanged();
  return changed;
}

// Trouble that clears within the CLI's first quick retries is not an outage worth a
// notification; a minute of it is. A failed attempt is always one.
export const OUTAGE_CONFIRM_MS = 60_000;
const offering = new Set<number>();

/**
 * Makes the one offer for this turn: its incident and checked alternatives, retained and
 * published as a `provider_outage` event that Thinkering turns into the notification.
 * Only his own messages are offered; an agent's request waits and reports through its
 * requester. `record` publishes the event (session-inputs' recordSessionEvent).
 */
export async function offerOutageChoices(input: { turnId: number; status: number | null },
  record: (event: { eventId: string; sessionId: number; inputId: string; turnId: number; kind: string; payload: unknown }) => void) {
  if (offering.has(input.turnId) || outageOfferForTurn(input.turnId)) return;
  const turn = db.query("SELECT id,session_id,accepted_input_id,provider_model,status FROM turns WHERE id=?").get(input.turnId) as any;
  if (!turn?.accepted_input_id || !["queued", "running"].includes(turn.status)) return;
  const accepted = db.query("SELECT origin FROM session_inputs WHERE id=?").get(turn.accepted_input_id) as { origin: string } | null;
  if (accepted?.origin !== "human") return;
  const session = getSessionById(turn.session_id);
  if (!session || session.provider_id === "chatgpt") return;
  offering.add(input.turnId);
  try {
    const provider = session.provider_id as ProviderId;
    // Another provider can only answer in a new conversation. The Inbox is one conversation
    // whose threads are its whole job, so it is offered the other Claude models only.
    const sameProviderOnly = inboxSession()?.id === turn.session_id;
    const [incident, alternatives] = await Promise.all([incidentFor(provider, turn.provider_model), verifiedAlternatives(provider, turn.provider_model, sameProviderOnly)]);
    const still = db.query("SELECT status FROM turns WHERE id=?").get(input.turnId) as { status: string } | null;
    if (!still || !["queued", "running"].includes(still.status)) return;
    const offer: OutageOffer = { turnId: turn.id, inputId: turn.accepted_input_id, sessionId: turn.session_id, provider, model: turn.provider_model,
      status: input.status, incident, alternatives, offeredAt: new Date().toISOString(), choice: null, chosenAt: null, rerunSessionId: null };
    const inserted = db.query("INSERT OR IGNORE INTO provider_outage_offers(turn_id,input_id,session_id,payload_json) VALUES(?,?,?,?)")
      .run(turn.id, turn.accepted_input_id, turn.session_id, JSON.stringify(offer)).changes === 1;
    if (!inserted) return;
    record({ eventId: `provider-outage:${turn.id}`, sessionId: turn.session_id, inputId: turn.accepted_input_id, turnId: turn.id, kind: "provider_outage",
      payload: { inputId: turn.accepted_input_id, provider, model: turn.provider_model, modelLabel: modelLabel(turn.provider_model), status: input.status,
        incident, alternatives: alternatives.map(({ alias, label }) => ({ alias, label })) } });
    log("warn", "provider_outage_offered", { turn_id: turn.id, session_id: turn.session_id, status: input.status,
      incident: incident?.name ?? null, alternatives: alternatives.map(item => item.alias) });
    executionChanged();
  } catch (error) {
    log("error", "provider_outage_offer_failed", { turn_id: input.turnId, error: error instanceof Error ? error.message : String(error) });
  } finally {
    offering.delete(input.turnId);
  }
}
