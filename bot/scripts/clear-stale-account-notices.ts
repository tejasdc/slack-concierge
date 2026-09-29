/**
 * Every account notice ever stored on a conversation, removed.
 *
 * These announced which Claude account a conversation was running on. Tejas found 27 of them
 * pinned across his conversations on 2026-09-29 and then removed the whole category: "What the
 * fuck does it matter for me if you ran on one account or not? What matters for me is actually
 * you continue to make sure everything is working and like we never face an issue of an user is
 * running out." Nothing produces them any more; this clears the ones already on his screen so he
 * does not have to close them one at a time.
 *
 * Only the sentence goes. The `account` ledger events stay exactly as they are — they record
 * which account ran each turn and why, which is what a diagnosis needs and has no words in it
 * for him.
 *
 * Run from the repository with CONCIERGE_STATE_DIR pointing at the live state directory.
 */
import { db } from "../src/state";

const cleared = db.query(`UPDATE sessions
  SET native_metadata_json = json_set(native_metadata_json,'$.claudeAccountNotice', json('null'))
  WHERE json_extract(native_metadata_json,'$.claudeAccountNotice') IS NOT NULL`).run().changes;
console.log(JSON.stringify({ cleared }));
