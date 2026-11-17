/** Compact, additive fields for the marked capture CLI; the raw response stays bounded. */
export const CAPTURE_RESPONSE_PREVIEW_LIMIT = 2000;

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : null;

const pickTyped = (source: RecordValue, fields: Record<string, (value: unknown) => boolean>): RecordValue => Object.fromEntries(
  Object.entries(fields).filter(([key, accepts]) => accepts(source[key])).map(([key]) => [key, source[key]]),
);
const stringValue = (value: unknown): boolean => typeof value === 'string';
const nullableString = (value: unknown): boolean => value === null || stringValue(value);
const booleanValue = (value: unknown): boolean => typeof value === 'boolean';

/** Parse before truncation and whitelist fields so the retained request is never echoed. */
export function captureResponseSummary(raw: string, result?: unknown) {
  let parsed = record(result);
  if (!parsed) {
    try { parsed = record(JSON.parse(raw)); } catch { parsed = null; }
  }
  const operation = record(parsed?.operation);
  const agentTest = record(parsed?.agentTest);
  return {
    body: raw.slice(0, CAPTURE_RESPONSE_PREVIEW_LIMIT),
    ...(operation ? { operation: pickTyped(operation, {operationId:stringValue,inputId:nullableString,sessionId:stringValue,
      origin:stringValue,humanAuthored:booleanValue,kind:stringValue,state:stringValue}) } : {}),
    ...(agentTest ? { agentTest: pickTyped(agentTest, {notificationRequest:nullableString,humanNotificationArmed:booleanValue}) } : {}),
  };
}
