/** File-only installed compatibility entrance. Never imports the owner database. */
import {resolve} from 'node:path';
import {TrustedRootReleaseManager,defaultReleaseEnvironment} from '../src/deployment-release';
import {assertCodexMutationReleaseActivation,codexMutationFirstProtectionReadiness} from '../src/codex-mutation-release-compatibility';
const option=(name:string)=>{const at=process.argv.indexOf(name);return at<0?null:process.argv[at+1]??null;};
try{
  if(process.argv[2]==='first-protection-preflight'){
    console.log(JSON.stringify(codexMutationFirstProtectionReadiness()));process.exit(75);
  }
  const controlOnly=process.argv[2]==='control';
  if(process.argv[2]!=='startup'&&!controlOnly)throw new Error('usage: codex-mutation-release-check <first-protection-preflight|startup|control>');
  const app=option('--app'),control=option('--control'),state=option('--state');
  if(!control||!state||!controlOnly&&!app)throw new Error('CODEX_MUTATION_RELEASE_SELECTION_UNPROVEN');
  const manager=new TrustedRootReleaseManager(defaultReleaseEnvironment(process.env.CONCIERGE_REPO||'/var/lib/slack-concierge-deployment/source'));
  const controller=manager.verify(resolve(control));
  if(!controlOnly){const application=manager.verify(resolve(app!));assertCodexMutationReleaseActivation(resolve(state),resolve(app!),application.files);}
  assertCodexMutationReleaseActivation(resolve(state),resolve(control),controller.files,true);
}catch(error){process.stderr.write((error instanceof Error?error.message:'CODEX_MUTATION_RELEASE_SELECTION_UNPROVEN')+'\n');process.exit(1);}
