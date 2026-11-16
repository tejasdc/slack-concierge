import type {Database} from 'bun:sqlite';
import {HIS_TIME_ZONE} from "./agent-local-time";

export function noticeTime(db: Database, ms: number): string {
  let timeZone = HIS_TIME_ZONE;
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

