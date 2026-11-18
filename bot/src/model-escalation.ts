import {CURRENT_ASTRA_MODEL,isAstraModel,modelDisplayName} from './aliases';

const ASTRA_LABEL=modelDisplayName(CURRENT_ASTRA_MODEL);

export function topModel(model:string|null|undefined):'fable'|'astra'|null {
  // Every Fable shares one "Fable only" weekly cap, so any Fable version is the top tier.
  if(model&&/^claude-fable-\d/.test(model))return 'fable';
  if(isAstraModel(model))return 'astra';
  return null;
}

export function escalationReason(model:string|null|undefined,reason:string|undefined,humanChoice:boolean):string|null {
  const tier=topModel(model);
  if(!tier||humanChoice)return null;
  const value=reason?.trim();
  if(!value)return `${tier==='fable'?'Claude Fable':ASTRA_LABEL} requires --escalation-reason naming the model-selection trigger. Choose cc-opus or cx-sol for an ordinary start.`;
  const trigger=/failed fix|regression|same issue|repeat(?:ed)? (?:issue|failure|report)|frustrat|unavailable|usage limit|allowance|capacity/i;
  if(!trigger.test(value))return 'The escalation reason must name the failed fix, regression, repeated issue, frustration, or unavailable named model. Choose cc-opus or cx-sol for an ordinary start.';
  if(tier==='astra'&&!/three|3\+?|third/i.test(value))return `${ASTRA_LABEL} requires three reports or failed fixes of this issue. Choose cx-sol or ChatGPT Pro first.`;
  if(tier==='astra'&&!/chatgpt pro.*(?:unavailable|failed|did not hold)|(?:unavailable|failed|did not hold).*chatgpt pro/i.test(value))return `${ASTRA_LABEL} also requires ChatGPT Pro to be unavailable or its answer not to hold. Choose ChatGPT Pro or cx-sol.`;
  if(tier==='fable'&&!/(?:gpt|codex).*(?:unavailable|usage limit|allowance|capacity)|(?:unavailable|usage limit|allowance|capacity).*(?:gpt|codex)/i.test(value))return 'Claude Fable requires the named GPT investigator to be unavailable. Choose cc-opus or cx-sol.';
  return null;
}
