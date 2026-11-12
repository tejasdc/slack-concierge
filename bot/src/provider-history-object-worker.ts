/** Convert one completed cache snapshot without blocking the session owner. */
import { migrateHistorySnapshot } from "./provider-history-object-migrate";

const sessionUuid = process.argv[2];
if (!sessionUuid) throw new Error("INVALID_HISTORY_REQUEST");
const result = await migrateHistorySnapshot(sessionUuid, true);
process.stdout.write(JSON.stringify(result) + "\n");
