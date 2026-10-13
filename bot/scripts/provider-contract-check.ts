import {strict as assert} from 'node:assert';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {PROVIDER_CONTRACT,PROVIDER_GUARANTEES} from '../src/provider-contract';

/**
 * Refuse a release when a provider does not answer the provider contract, or when the code that
 * enforces a guarantee decides it by provider name instead of reading the contract. The build does
 * not type-check, so the union-keyed table alone would not stop a fourth provider; this does.
 */
export function checkProviderContract(root=resolve(import.meta.dir,'..')) {
  const read=(path:string)=>readFileSync(resolve(root,path),'utf8');
  const union=read('src/state.ts').match(/export type ProviderId\s*=\s*([^;]+);/)?.[1];
  assert.ok(union,'ProviderId union not found');
  const declared=[...union.matchAll(/"([^"]+)"/g)].map(match=>match[1]).sort();
  assert.deepEqual(Object.keys(PROVIDER_CONTRACT).sort(),declared,'every provider must answer the provider contract');
  for(const [provider,contract] of Object.entries(PROVIDER_CONTRACT))for(const guarantee of PROVIDER_GUARANTEES){
    const answer=contract.guarantees[guarantee] as Record<string,unknown>|undefined;
    assert.ok(answer,`${provider} does not answer ${guarantee}`);
    if(answer.met===true)assert.ok(typeof answer.how==='string'&&answer.how.trim(),`${provider} ${guarantee}: say how it is met`);
    else{
      assert.ok(typeof (answer.platformLimit??answer.notBuilt)==='string'&&String(answer.platformLimit??answer.notBuilt).trim(),
        `${provider} ${guarantee}: name the platform limit or what is not built`);
      assert.ok(typeof answer.instead==='string'&&answer.instead.trim(),`${provider} ${guarantee}: say what happens instead`);
    }
  }
  // Session-running providers take their capability flags from the contract, never a literal.
  const providers=read('src/providers.ts');
  for(const [name,id] of [['CodexProvider','codex'],['ClaudeCodeProvider','claude-code'],['AntigravityProvider','antigravity']] as const){
    const block=providers.match(new RegExp(`class ${name}[^]*?capabilities: ProviderCapabilities = \\{([^]*?)\\};`))?.[1];
    assert.ok(block,`${name} capabilities not found`);
    for(const flag of ['steer','stop','history','fork'])
      assert.match(block,new RegExp(`${flag}: guaranteeMet\\("${id}", "${flag}"\\)`),`${name}.${flag} must come from the provider contract`);
  }
  // What an update waits for and what may start during one come from the contract.
  const survival=read('src/execution-survival.ts');
  assert.match(survival,/PROVIDER_CONTRACT/,'the update rule must read the provider contract');
  assert.doesNotMatch(survival,/["'`]claude-code\/|["'`]antigravity\//,'the update rule must not name providers');
  for(const path of ['src/session-owner.ts','src/prepared-receipt-core.ts','src/state.ts'])
    assert.doesNotMatch(read(path),/survivable\??\.(claude|codexShared)/,`${path} must ask which providers may start, not name them`);
  // A provider that runs on both machines is set up by both installers.
  const serverInstall=read('scripts/deploy.sh'),macInstall=read('../scripts/install-mac.sh');
  for(const [provider,contract] of Object.entries(PROVIDER_CONTRACT))for(const step of contract.machineSetup){
    assert.ok(serverInstall.includes(step),`${provider} on the server: deploy.sh must run ${step}`);
    assert.ok(macInstall.includes(step),`${provider} on the Mac: install-mac.sh must run ${step}`);
  }
  return {providers:Object.keys(PROVIDER_CONTRACT).length,guarantees:PROVIDER_GUARANTEES.length};
}

if(import.meta.main)console.log(JSON.stringify(checkProviderContract()));
