import type {Database} from 'bun:sqlite';

export function noticeTime(db: Database, ms: number): string {
  let timeZone = "America/New_York";
  try {
    const row = db.query("SELECT time_zone FROM saved_work_settings WHERE singleton=1").get() as { time_zone: string } | null;
    if (row?.time_zone) timeZone = row.time_zone;
  } catch {}
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone, month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "shortGeneric" }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString();
  }
}

