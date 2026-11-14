import {assertCodexMutationApplicationStartup} from './codex-mutation-application-startup';
// Mac launchd starts the checkout directly, without the sealed Linux launcher.
// It cannot satisfy a retained sealed-application requirement by carrying JSON.
if(process.env.CONCIERGE_STATE_DIR)assertCodexMutationApplicationStartup({stateDirectory:process.env.CONCIERGE_STATE_DIR,
  mainPath:Bun.main,manifestPath:process.env.CONCIERGE_RELEASE_MANIFEST,releaseRoot:process.env.CONCIERGE_DEPLOYMENT_RELEASE_ROOT});
