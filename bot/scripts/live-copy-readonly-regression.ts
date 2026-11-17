import { strict as assert } from 'node:assert';
import { liveStoreCopyRefusal } from '../src/live-store-copy-policy';

const cwd = process.cwd();
const stores = { directories: ['/var/lib/concierge-ledger'], files: [] };
const read = `sed -n '25,75p' bot/scripts/agent-test-notification-receipt-fixture.ts; git grep -n imperativeDetail; python3 scripts/ledger-read.py --database /var/lib/concierge-ledger/state.db "SELECT id,status,desired_commit,updated_at FROM deployment_runs ORDER BY created_at DESC LIMIT 1"`;
assert.equal(liveStoreCopyRefusal(read, cwd, stores), null);
assert(liveStoreCopyRefusal(read + '; cp /var/lib/concierge-ledger/state.db /tmp/blocked-copy.db', cwd, stores));
assert(liveStoreCopyRefusal('bun run bot/scripts/agent-test-notification-receipt-fixture.ts /var/lib/concierge-ledger/state.db', cwd, stores));
assert(liveStoreCopyRefusal('sqlite3 /var/lib/concierge-ledger/state.db "CREATE TABLE x (id)"', cwd, stores));
console.log('PASS combined read, raw copy, fixture launch, SQL mutation');
