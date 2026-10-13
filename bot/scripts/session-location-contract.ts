import {strict as assert} from 'node:assert';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';

/** Refuse a release when the server and Mac compose different session peer entrances. */
export function checkSessionLocationComposition(root=resolve(import.meta.dir,'..')) {
  const read=(name:string)=>readFileSync(resolve(root,'src',name),'utf8');
  const native=read('session-runtime.ts');
  const adapter=read('index.ts');
  for(const [name,source] of [['native',native],['adapter',adapter]] as const){
    assert.match(source,/import\s*\{createSessionPeerServices\}\s*from\s*['"]\.\/session-peer-services['"]/,`${name} must use the shared session peer entrance`);
    assert.match(source,/createSessionPeerServices\s*\(/,`${name} must compose the shared session peer entrance`);
    assert.match(source,/bindOwner\s*\(/,`${name} must bind that entrance to its session owner`);
    assert.doesNotMatch(source,/new\s+(?:SessionPeers|SessionCommunicationCoordinator|ProjectSetup|PeerLinks)\s*\(/,
      `${name} must not add a machine-specific session peer path`);
  }
  const shared=read('session-peer-services.ts');
  for(const name of ['SessionPeers','SessionCommunicationCoordinator','ProjectSetup','PeerLinks'])
    assert.match(shared,new RegExp(`new\\s+${name}\\s*\\(`),`shared peer entrance is missing ${name}`);
  return {compositions:['native','adapter'],sharedPeerServices:4};
}

if(import.meta.main)console.log(JSON.stringify(checkSessionLocationComposition()));
