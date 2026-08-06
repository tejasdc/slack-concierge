type LogLevel = "debug" | "info" | "warn" | "error";

export function log(level: LogLevel, event: string, fields: Record<string, unknown> = {}) {
  const line = {
    ts: new Date().toISOString(),
    level,
    event,
    ...fields,
  };
  const payload = JSON.stringify(line);
  if (level === "error") console.error(payload);
  else console.log(payload);
}

export function errorFields(err: unknown) {
  if (err instanceof Error) return { error: err.message, stack: err.stack };
  return { error: String(err) };
}
