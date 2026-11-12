import {PROVIDER_ALIASES} from './aliases';

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
  return !!command&&/(?:\b(?:apply_patch|git apply|sed -i|perl -pi)\b|\btools\.apply_patch\s*\()/.test(command);
}
