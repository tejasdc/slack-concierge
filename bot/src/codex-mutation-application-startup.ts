import {lstatSync,realpathSync} from 'node:fs';
import {dirname,isAbsolute,join} from 'node:path';
import {TrustedRootReleaseManager,defaultReleaseEnvironment} from './deployment-release';
import {assertCodexMutationReleaseActivation,codexMutationReleaseRequirement} from './codex-mutation-release-compatibility';

export function assertCodexMutationApplicationStartup(input:{stateDirectory:string;mainPath:string;
  manifestPath?:string;releaseRoot?:string}){
  try{lstatSync(codexMutationReleaseRequirement(input.stateDirectory));}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
  try{
    if(!input.manifestPath||!isAbsolute(input.manifestPath))throw new Error('unsealed');
    const artifact=dirname(realpathSync(input.manifestPath)),releaseRoot=input.releaseRoot||'/var/lib/slack-concierge-deployment';
    const manager=new TrustedRootReleaseManager({...defaultReleaseEnvironment('/var/lib/slack-concierge-deployment/source'),releaseRoot});
    const application=manager.verify(artifact),control=realpathSync(join(releaseRoot,'control'));
    if(realpathSync(input.mainPath)!==join(artifact,'bot/src/index.js'))throw new Error('unsealed');
    assertCodexMutationReleaseActivation(input.stateDirectory,artifact,application.files);
    assertCodexMutationReleaseActivation(input.stateDirectory,control,manager.verify(control).files,true);
  }catch(error){
    if(error instanceof Error&&/^CODEX_MUTATION_(APPLICATION|CONTROL)_PROTOCOL_NOT_PROVEN$/.test(error.message))throw error;
    throw new Error('CODEX_MUTATION_UNSEALED_APPLICATION_STARTUP_UNPROVEN');
  }
}
