/** Pure shared classifier for the versioned launch helper and owner-side process proof. */
export type ManagedCodexInvocation =
  | { kind: 'read' }
  | { kind: 'proxy'; proxyIndex: number }
  | { kind: 'lifetime'; threadId: string | null };

const valueOptions=new Set(['-c','--config','--enable','--disable','--remote','--remote-auth-token-env',
  '-i','--image','-m','--model','--local-provider','-p','--profile','-s','--sandbox','-C','--cd',
  '--add-dir','-a','--ask-for-approval','--output-schema','--output-last-message','-o','--color','--thread-source','--sock']);
const switches=new Set(['--strict-config','--oss','--approve-for-me','--dangerously-bypass-approvals-and-sandbox',
  '--dangerously-bypass-hook-trust','--worktree','--search','--no-alt-screen','--no-daemon',
  '--skip-git-repo-check','--ephemeral','--ignore-user-config','--ignore-rules','--json']);

export function managedCodexInvocation(argv:string[]):ManagedCodexInvocation{
  const words:{value:string;index:number}[]=[];let help=false,uncertain=false;
  for(let index=0;index<argv.length;index++){
    const value=argv[index]!;
    if(value==='--'){words.push(...argv.slice(index+1).map((value,offset)=>({value,index:index+offset+1})));break;}
    if(valueOptions.has(value)){if(++index>=argv.length)uncertain=true;continue;}
    if(value.startsWith('--')&&value.includes('=')){if(!valueOptions.has(value.split('=')[0]!))uncertain=true;continue;}
    if(value==='--help'||value==='-h'||value==='--version'||value==='-V'){help=true;continue;}
    if(switches.has(value))continue;
    if(value.startsWith('-'))uncertain=true;
    words.push({value,index});
  }
  if(help||words[0]?.value==='help')return {kind:'read'};
  if(!uncertain&&words[0]?.value==='app-server'&&words[1]?.value==='proxy')
    return {kind:'proxy',proxyIndex:words[1].index};
  const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const resume=['resume','queue','archive','delete','unarchive','fork'].includes(words[0]?.value??'')?words[1]:
    ['exec','e'].includes(words[0]?.value??'')&&['resume','fork'].includes(words[1]?.value??'')?words[2]:null;
  return {kind:'lifetime',threadId:!uncertain&&resume&&uuid.test(resume.value)?resume.value:null};
}
