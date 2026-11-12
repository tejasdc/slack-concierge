import {getAcceptedSessionInput,sessionInputProvenance} from './session-inputs';
import {topModel} from './model-escalation';
import {isThinkingModel} from './implementation-models';
import {CHATGPT_THINKING_LEVELS,providerSpokenNames} from './aliases';

// A choice must be a directive in its own non-conditional statement. Keep decimal
// model versions intact and retain question marks until after classification.
export function containsHumanChoice(words:string,directive:RegExp):boolean {
  const statements=words.match(/(?:\d\.\d|[^.!?;\n])+[.!?;]?/g)??[];
  return statements.some(statement=>{
    if(statement.endsWith('?'))return false;
    const match=directive.exec(statement);
    if(!match)return false;
    const before=statement.slice(0,match.index);
    return !/\b(?:not|never|avoid|don't|do not|stop|without|instead of|rather than|if|unless|when|provided|assuming|maybe|perhaps|can|may|shall|will|could|would|should|might|whether)\b/i.test(before)
      && !/\b(?:if|unless|when|provided|assuming|maybe|perhaps|might|could|would)\b/i.test(statement.slice(match.index+match[0].length));
  });
}

export function humanChoseTopModel(sourceInputId:string|undefined,model:string):boolean {
  if(!sourceInputId)return false;
  const source=getAcceptedSessionInput(sourceInputId);
  if(!source)return false;
  const provenance=source.origin==='human'?null:sessionInputProvenance(source);
  const humanId=source.origin==='human'?source.id:provenance?.originatingHuman?.inputId;
  const human=humanId?getAcceptedSessionInput(humanId):null;
  if(!human||human.origin!=='human')return !!provenance?.originatingHuman&&!!topModel(model)
    &&'humanModelChoices' in provenance&&Array.isArray(provenance.humanModelChoices)
    &&provenance.humanModelChoices.some((choice:unknown)=>typeof choice==='string'&&topModel(choice)===topModel(model));
  const words=JSON.parse(human.payload_json).text;
  if(typeof words!=='string')return false;
  const name=topModel(model)==='fable'?'fable':'astra';
  const directive=new RegExp(`\\b(?:use|choose|run|start|switch to|go with)\\s+(?:GPT-6\\s+)?${name}\\b`,'i');
  return containsHumanChoice(words,directive);
}

/** Verified human words or the same model-specific choice retained by an authenticated peer. */
export function humanChoseThinkingModel(sourceInputId:string|undefined,model:string):boolean {
  if(topModel(model))return humanChoseTopModel(sourceInputId,model);
  if(!isThinkingModel(model)||!sourceInputId)return false;
  const source=getAcceptedSessionInput(sourceInputId);
  if(!source)return false;
  const provenance=source.origin==='human'?null:sessionInputProvenance(source);
  const humanId=source.origin==='human'?source.id:provenance?.originatingHuman?.inputId;
  const human=humanId?getAcceptedSessionInput(humanId):null;
  if(!human||human.origin!=='human')return !!provenance?.originatingHuman
    &&Array.isArray(provenance.humanModelChoices)&&provenance.humanModelChoices.includes(model);
  const words=JSON.parse(human.payload_json).text;
  if(typeof words!=='string')return false;
  const name=/opus/i.test(model)?'Opus':/(?:^|-)sol$/i.test(model)?'Sol':null;
  if(!name)return false;
  const prefix=name==='Sol'?model.slice(0,-4).replace(/\./g,'\\.'):'Claude';
  const directive=new RegExp(`\\b(?:use|choose|run|start|switch to|go with)\\s+(?:${prefix}\\s+)?${name}\\b`,'i');
  return containsHumanChoice(words,directive);
}

/** A declared research route honors the human's explicit provider, including a retained peer choice. */
export function humanChoseProvider(sourceInputId:string|undefined,provider:string):boolean {
  if(!sourceInputId||!['claude-code','codex','antigravity','chatgpt'].includes(provider))return false;
  const source=getAcceptedSessionInput(sourceInputId);
  if(!source)return false;
  const provenance=source.origin==='human'?null:sessionInputProvenance(source);
  const humanId=source.origin==='human'?source.id:provenance?.originatingHuman?.inputId;
  const human=humanId?getAcceptedSessionInput(humanId):null;
  if(!human||human.origin!=='human')return !!provenance?.originatingHuman
    &&Array.isArray(provenance.humanProviderChoices)&&provenance.humanProviderChoices.includes(provider);
  const words=JSON.parse(human.payload_json).text;
  if(typeof words!=='string')return false;
  const chosen=`(?:${providerSpokenNames(provider).join('|')})`;
  const directive=new RegExp(`\\b(?:use|choose|run|start|switch to|go with)\\s+(?:the\\s+)?${chosen}\\b`,'i');
  return containsHumanChoice(words,directive);
}

/** Human-selected ChatGPT thinking level is retained across machines; an agent cannot assert it in request text. */
export function humanChoseChatGptEffort(sourceInputId:string|undefined,effort:string):boolean {
  if(!sourceInputId||!CHATGPT_THINKING_LEVELS.includes(effort as any))return false;
  const source=getAcceptedSessionInput(sourceInputId);
  if(!source)return false;
  const provenance=source.origin==='human'?null:sessionInputProvenance(source);
  const humanId=source.origin==='human'?source.id:provenance?.originatingHuman?.inputId;
  const human=humanId?getAcceptedSessionInput(humanId):null;
  if(!human||human.origin!=='human')return !!provenance?.originatingHuman
    &&Array.isArray(provenance.humanChatGptEfforts)&&provenance.humanChatGptEfforts.includes(effort);
  const words=JSON.parse(human.payload_json).text;
  if(typeof words!=='string')return false;
  const directive=new RegExp(`\\b(?:use|choose|run|start|switch to|go with)\\s+ChatGPT\\s+(?:at\\s+)?${effort.replace('-','[ -]')}\\b`,'i');
  return containsHumanChoice(words,directive);
}
