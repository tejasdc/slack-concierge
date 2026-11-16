// Every time an agent reads from Concierge also carries Tejas's own clock, written the way he
// says it ("11:25 PM Eastern, Nov 15"), so no agent converts server UTC by hand. The Inbox router
// told him a UTC time as his local time more than once (request 919227d1, 2026-11-16).
// Machine timestamps stay exactly as they are for code; the local reading is added beside them.
// Applied at the two places agents read from: the router-actions command output and the text
// of every non-human input (agent requests, service notices, stall and upkeep messages).

// His zone. The saved-work settings row defaults to the same value and nothing changes it;
// notice-time.ts reads that row for owner-side notices.
export const HIS_TIME_ZONE = 'America/New_York';

const formatters = new Map<string, { clock: Intl.DateTimeFormat; day: Intl.DateTimeFormat; label: string }>();

function formatterFor(timeZone: string) {
  let entry = formatters.get(timeZone);
  if (!entry) {
    let label = timeZone;
    try {
      const zoneName = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longGeneric' })
        .formatToParts(new Date()).find(part => part.type === 'timeZoneName')?.value;
      if (zoneName) label = zoneName.replace(/ Time$/, '');
    } catch {}
    entry = {
      clock: new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }),
      day: new Intl.DateTimeFormat('en-US', { timeZone, month: 'short', day: 'numeric' }),
      label,
    };
    formatters.set(timeZone, entry);
  }
  return entry;
}

/** "11:25 PM Eastern, Nov 15" */
export function hisLocalTime(ms: number, timeZone = HIS_TIME_ZONE): string {
  const at = new Date(ms);
  if (!Number.isFinite(at.getTime())) return '';
  const { clock, day, label } = formatterFor(timeZone);
  // ICU puts a narrow no-break space before AM/PM; agents and he read an ordinary space.
  return `${clock.format(at).replace(/\s/g, " ")} ${label}, ${day.format(at)}`;
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?Z$/;
// An ISO UTC timestamp inside prose, unless an earlier pass already put his time after it.
const ISO_UTC_IN_TEXT = /\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?Z)(?! \(\d{1,2}:\d{2}\s?[AP]M )/g;
// Epoch milliseconds between 2017 and 2096: never a duration, so a key holding one is a moment.
const EPOCH_MS_MIN = 1.5e12, EPOCH_MS_MAX = 4e12;
const MOMENT_KEY = /(?:at|At|until|Until|since|Since|time|Time)(?:_?[Mm]s)?$|(?:_ms|Ms)$/;

/** A Concierge ledger time: ISO UTC, or SQLite CURRENT_TIMESTAMP ("2026-11-16 04:25:00"), which is UTC without a zone. */
export function hisLocalTimeOfLedgerUtc(value: string, timeZone = HIS_TIME_ZONE): string {
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(value) ? `${value.replace(" ", "T")}Z` : value;
  return ISO_UTC.test(iso) ? hisLocalTime(Date.parse(iso), timeZone) : "";
}

/** Adds "(11:25 PM Eastern, Nov 15)" after each ISO UTC timestamp in text. Idempotent. */
export function annotateTextWithHisTime(text: string, timeZone = HIS_TIME_ZONE): string {
  if (!text.includes('T') || !text.includes('Z')) return text;
  return text.replace(ISO_UTC_IN_TEXT, (iso: string) => {
    const local = hisLocalTime(Date.parse(iso), timeZone);
    return local ? `${iso} (${local})` : iso;
  });
}

function localKey(key: string) {
  return /[A-Z]/.test(key) || !key.includes('_') ? `${key}Local` : `${key}_local`;
}

/**
 * A copy of a JSON value for an agent to read: each field holding a UTC moment (ISO string or
 * epoch milliseconds) gains a sibling "<field>Local" with his time, and prose fields get the
 * inline reading after each timestamp. Existing fields keep their exact machine values.
 */
export function withHisLocalTimes(value: unknown, timeZone = HIS_TIME_ZONE): unknown {
  if (typeof value === 'string') return ISO_UTC.test(value) || /^\s*[{[]/.test(value) ? value : annotateTextWithHisTime(value, timeZone);
  if (Array.isArray(value)) return value.map(item => withHisLocalTimes(item, timeZone));
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  const source = value as Record<string, unknown>;
  for (const [key, field] of Object.entries(source)) {
    out[key] = withHisLocalTimes(field, timeZone);
    const sibling = localKey(key);
    if (sibling in source) continue;
    if (typeof field === 'string' && ISO_UTC.test(field)) out[sibling] = hisLocalTime(Date.parse(field), timeZone);
    else if (typeof field === 'number' && field >= EPOCH_MS_MIN && field <= EPOCH_MS_MAX && MOMENT_KEY.test(key))
      out[sibling] = hisLocalTime(field, timeZone);
  }
  return out;
}

/** The JSON line router-actions prints for agents. */
export function agentJson(value: unknown): string {
  return JSON.stringify(withHisLocalTimes(value));
}
