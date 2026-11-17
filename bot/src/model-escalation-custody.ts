import {getAcceptedSessionInput,sessionInputProvenance} from './session-inputs';
import {topModel} from './model-escalation';
import {isThinkingModel} from './implementation-models';
import {CHATGPT_THINKING_LEVELS,providerSpokenNames} from './aliases';

// Split his message into statements, keeping decimal model versions ("GPT-6.1") whole and
// retaining each statement's closing mark so questions can be told apart.
function statements(words:string):string[] {
  return words.replace(/\s*\n\s*/g,' ').match(/(?:\d\.\d|[^.!?;])+[.!?;]?/g)??[];
}

/**
 * Kept for the Inbox pin, whose deliberate friction requires an exact "move the Inbox to …"
 * directive. Model, provider and effort choices use `hisWordsChoose` below instead.
 */
export function containsHumanChoice(words:string,directive:RegExp):boolean {
  return statements(words).some(statement=>{
    if(statement.endsWith('?'))return false;
    const match=directive.exec(statement);
    if(!match)return false;
    const before=statement.slice(0,match.index);
    return !/\b(?:not|never|avoid|don't|do not|stop|without|instead of|rather than|if|unless|when|provided|assuming|after|once|until|maybe|perhaps|can|may|shall|will|could|would|should|might|whether)\b/i.test(before)
      && !/\b(?:if|unless|when|provided|assuming|after|once|until|maybe|perhaps|might|could|would)\b/i.test(statement.slice(match.index+match[0].length));
  });
}

// Whether he chose something is read from the shape of his sentence, not from a list of verbs:
// on 2026-11-17 the six-verb rule (use|choose|run|start|switch to|go with) missed "Have Sol do
// it", "Put Opus on it", "Could you use Fable?" and "I want Astra for this one", and the refusal
// went to the agent while he was never asked. Only closed grammatical classes are listed here
// (fillers, pronouns, auxiliaries, negators, conditionals), which English does not grow.
const FILLER=/^(?:(?:ok(?:ay)?|so|and|but|then|just|hey|yes|yeah|alright|now|also|please)\b[,\s]*)+/i;
// A polite request or a stated want is his instruction, even phrased as a question.
const REQUEST=/^(?:can|could|would|will)\s+(?:you|we)\b|^let(?:'s|\s+us)\b|^(?:I|we)(?:'d|\s+would)?\s+(?:really\s+)?(?:want|need|like|prefer)\b|^you\s+(?:can|should|must|need\s+to|have\s+to|may|will|'ll)\b/i;
// Words that cannot open an imperative sentence: a statement starting with one is a remark
// ("I think Astra is overkill", "The Sol run failed") or an inquiry, not an instruction.
const NOT_IMPERATIVE=/^(?:i|i'm|i've|you|he|she|it|it's|we|they|this|that|these|those|there|the|a|an|my|your|our|his|its|their|is|are|was|were|am|been|has|had|does|did|should|shall|may|must|might|what|which|who|why|how|where|whose|or)\b/i;
const NEGATION=/\b(?:not|never|no|avoid|stop|without|instead\s+of|rather\s+than|skip|except)\b|n't\b|\bdo\s+not\b/i;
// A condition or hedge makes it a rule for later, not a choice now ("if it fails, use Astra").
const CONDITION=/\b(?:if|unless|when|whenever|once|after|until|provided|assuming|in\s+case|maybe|perhaps|might|whether)\b/i;

/** True when one of his statements asks for the thing `mention` finds, now and without negation. */
export function hisWordsChoose(words:string,mention:RegExp):boolean {
  return statements(words).some(raw=>{
    const statement=raw.trim().replace(FILLER,'');
    const found=new RegExp(mention.source,mention.flags.replace('g','')).exec(statement);
    if(!found)return false;
    if(NEGATION.test(statement.slice(0,found.index))||CONDITION.test(statement))return false;
    if(REQUEST.test(statement))return true;
    if(statement.endsWith('?'))return false;
    return found.index>0&&!NOT_IMPERATIVE.test(statement);
  });
}

function humanWords(sourceInputId:string|undefined):{words:string|null;provenance:any}|null {
  if(!sourceInputId)return null;
  const source=getAcceptedSessionInput(sourceInputId);
  if(!source)return null;
  const provenance=source.origin==='human'?null:sessionInputProvenance(source);
  const humanId=source.origin==='human'?source.id:provenance?.originatingHuman?.inputId;
  const human=humanId?getAcceptedSessionInput(humanId):null;
  if(!human||human.origin!=='human')return {words:null,provenance};
  const words=JSON.parse(human.payload_json).text;
  return {words:typeof words==='string'?words:'',provenance};
}

// A versioned mention ("GPT-6.1 Sol") names only that version; a bare "Sol" names any Sol.
function modelMention(model:string):RegExp|null {
  const top=topModel(model);
  if(top==='astra')return /\b(?:GPT-?\s?6\s+)?Astra\b/i;
  if(top==='fable')return /\b(?:Claude\s+)?Fable\b/i;
  if(/opus/i.test(model))return /\b(?:Claude\s+)?Opus\b/i;
  const sol=/^gpt-([\d.]+)-sol$/i.exec(model);
  if(sol)return new RegExp(`(?:\\bGPT-?\\s?${sol[1]!.replace(/\./g,'\\.')}\\s+Sol|(?<![\\w.-]|\\d\\s)Sol)\\b`,'i');
  return null;
}

export function humanChoseTopModel(sourceInputId:string|undefined,model:string):boolean {
  const human=humanWords(sourceInputId);
  if(!human)return false;
  if(human.words===null)return !!human.provenance?.originatingHuman&&!!topModel(model)
    &&Array.isArray(human.provenance.humanModelChoices)
    &&human.provenance.humanModelChoices.some((choice:unknown)=>typeof choice==='string'&&topModel(choice)===topModel(model));
  const mention=modelMention(model);
  return !!mention&&!!topModel(model)&&hisWordsChoose(human.words,mention);
}

/** Verified human words or the same model-specific choice retained by an authenticated peer. */
export function humanChoseThinkingModel(sourceInputId:string|undefined,model:string):boolean {
  if(topModel(model))return humanChoseTopModel(sourceInputId,model);
  if(!isThinkingModel(model))return false;
  const human=humanWords(sourceInputId);
  if(!human)return false;
  if(human.words===null)return !!human.provenance?.originatingHuman
    &&Array.isArray(human.provenance.humanModelChoices)&&human.provenance.humanModelChoices.includes(model);
  const mention=modelMention(model);
  return !!mention&&hisWordsChoose(human.words,mention);
}

/** A declared research route honors the human's explicit provider, including a retained peer choice. */
export function humanChoseProvider(sourceInputId:string|undefined,provider:string):boolean {
  if(!['claude-code','codex','antigravity','chatgpt'].includes(provider))return false;
  const human=humanWords(sourceInputId);
  if(!human)return false;
  if(human.words===null)return !!human.provenance?.originatingHuman
    &&Array.isArray(human.provenance.humanProviderChoices)&&human.provenance.humanProviderChoices.includes(provider);
  return hisWordsChoose(human.words,new RegExp(`\\b(?:${providerSpokenNames(provider).join('|')})\\b`,'i'));
}

// ChatGPT's thinking levels as he says them. Older ChatGPT menus offered Light, Standard,
// Extended and Heavy; they map by position onto the composer's light/medium/high/extra-high.
const SPOKEN_CHATGPT_LEVELS:Record<string,string>={
  light:'light',medium:'medium|standard',high:'high|extended','extra-high':'extra[- ]?high|x-?high|heavy',pro:'pro',
};

/** Human-selected ChatGPT thinking level is retained across machines; an agent cannot assert it in request text. */
export function humanChoseChatGptEffort(sourceInputId:string|undefined,effort:string):boolean {
  if(!CHATGPT_THINKING_LEVELS.includes(effort as any))return false;
  const human=humanWords(sourceInputId);
  if(!human)return false;
  if(human.words===null)return !!human.provenance?.originatingHuman
    &&Array.isArray(human.provenance.humanChatGptEfforts)&&human.provenance.humanChatGptEfforts.includes(effort);
  const level=`(?:${SPOKEN_CHATGPT_LEVELS[effort]})`;
  // The level must be said as ChatGPT's thinking level, in the same statement that names ChatGPT.
  const said=new RegExp(`\\bChatGPT\\s+(?:(?:at|on|with|in)\\s+)?${level}\\b|\\b(?:at|on|with|in)\\s+${level}\\b|\\b${level}\\s+(?:thinking|effort|reasoning)\\b`,'i');
  return statements(human.words).some(statement=>said.test(statement)&&hisWordsChoose(statement,/\bChatGPT\b/i));
}
