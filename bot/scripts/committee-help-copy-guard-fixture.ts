import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { liveStoreCopyRefusal } from '../src/live-store-copy-policy';

const committee = '/root/workspace/agent-ecology/scripts/committee.py';
if (existsSync(committee)) {
  for (const action of ['open', 'twin']) {
    assert.equal(liveStoreCopyRefusal(`python3 ${committee} ${action} --help`), null);
    assert.equal(liveStoreCopyRefusal(`PYTHONPATH=/root/workspace/agent-ecology/scripts python3 scripts/committee.py ${action} --help`,
      '/root/workspace/agent-ecology'), null);
  }
  assert(liveStoreCopyRefusal(`python3 ${committee} notebook-log --help`));
  assert(liveStoreCopyRefusal(`python3 ${committee} open --help; cp /root/.local/state/concierge/state.db /tmp/raw.db`));
  console.log('committee help allowed; other action and raw copy refused');
}
