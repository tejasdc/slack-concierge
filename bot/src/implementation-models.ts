import {PROVIDER_ALIASES} from './aliases';
import {parseShell} from './history-rewrite-policy';

export const IMPLEMENTATION_ALIASES = ['cc-haiku','cc-sonnet','cx-luna','cx-terra','cx-sol'] as const;
export type ImplementationAlias = typeof IMPLEMENTATION_ALIASES[number];

/** A designer can choose a stronger implementer when the fixed task needs it. */
export function implementationAlias(parent:'claude-code'|'codex',choice:string|undefined):ImplementationAlias {
  const selected=choice&&choice!=='auto'?choice:parent==='claude-code'?'cc-sonnet':'cx-luna';
  if(!IMPLEMENTATION_ALIASES.includes(selected as ImplementationAlias)
    ||PROVIDER_ALIASES[selected as ImplementationAlias].provider!==parent)
    throw new Error(`Choose an implementation model from ${IMPLEMENTATION_ALIASES.filter(alias=>PROVIDER_ALIASES[alias].provider===parent).join(', ')}.`);
  return selected as ImplementationAlias;
}

/** Includes older bound models so resumed conversations get the same reminder. */
export function isThinkingModel(model:string|null|undefined):boolean {
  return !!model&&(/claude-(?:opus|fable)-/.test(model)||/^gpt-(?:5\.6|6(?:\.1)?)-sol$/.test(model)||model==='gpt-6-astra'||model==='opus[1m]');
}

/** Recognized code-editing tool calls. Scripted writes without a named edit operation are unknown. */
export function isCodeEditTool(name:string|null|undefined,input?:unknown):boolean {
  const normalized=name?.toLowerCase().replace(/[^a-z]/g,'')??'';
  if(['edit','multiedit','write','notebookedit','filechange','applypatch'].includes(normalized))return true;
  const command=typeof input==='string'?input:input&&typeof input==='object'
    ?String((input as Record<string,unknown>).command??(input as Record<string,unknown>).cmd??(input as Record<string,unknown>).code??''):'';
  return command!==''&&shellEditsCode(command);
}

/** Look at executable shell words, never the text of a report, quoted argument or note. */
function shellEditsCode(source:string,depth=0):boolean {
  if(depth>4)return false;
  for(const simple of parseShell(source)) {
    if(simple.substitutions.some(inner=>shellEditsCode(inner,depth+1)))return true;
    let words=simple.words.map(word=>word.text);
    while(words.length&&/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!))words=words.slice(1);
    while(['env','command','exec','nohup','time'].includes(words[0]?.split('/').pop()??'')) {
      words=words.slice(1);
      while(words.length&&(words[0]!.startsWith('-')||/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!)))words=words.slice(1);
    }
    const head=words[0]?.split('/').pop();
    if(['bash','sh','zsh','dash','ksh'].includes(head??'')) {
      const option=words.findIndex(word=>/^-[a-z]*c[a-z]*$/.test(word));
      if(option>=0&&shellEditsCode(words[option+1]??'',depth+1))return true;
      continue;
    }
    if(head==='apply_patch'||head==='git'&&words[1]==='apply'
      ||head==='sed'&&words.some(word=>word==='--in-place'||/^(?:-[a-zA-Z]*i)(?:\..*)?$/.test(word))
      ||head==='perl'&&words.some(word=>/^-[a-zA-Z]*pi(?:\..*)?$/.test(word)))return true;
  }
  return false;
}
