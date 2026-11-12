import {homedir} from 'node:os';

/** Keep global/system Git config disabled while explicitly retaining the runner's gh login. */
export function runnerGithubGitEnvironment(base:NodeJS.ProcessEnv=process.env,gh='/usr/bin/gh'):NodeJS.ProcessEnv {
  return {
    ...base,
    HOME:base.HOME??homedir(),
    GIT_TERMINAL_PROMPT:'0',
    GCM_INTERACTIVE:'never',
    GIT_LFS_SKIP_SMUDGE:'1',
    GIT_CONFIG_NOSYSTEM:'1',
    GIT_CONFIG_GLOBAL:'/dev/null',
    // Git reads these after config files. The empty first helper clears inherited helpers;
    // the second invokes the runner's authenticated GitHub CLI account without changing ~/.gitconfig.
    GIT_CONFIG_COUNT:'2',
    GIT_CONFIG_KEY_0:'credential.helper',
    GIT_CONFIG_VALUE_0:'',
    GIT_CONFIG_KEY_1:'credential.helper',
    GIT_CONFIG_VALUE_1:`!${gh} auth git-credential`,
  };
}
