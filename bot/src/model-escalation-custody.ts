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
// went to the agent while he was never asked. This check is consulted only when an agent is
// about to use that exact model, so it errs toward his words counting: a statement counts when
// it is a command, polite request or stated want that names the model, unless that clause
// negates or sets the name aside, the statement is conditional or hedged, or he retracts it.
// The lists are closed grammatical classes. Two independent reviews on 2026-11-17 showed that
// a list of verbs that do or do not choose cannot be completed in either direction.
const FILLER=/^(?:(?:ok(?:ay)?|so|and|but|then|just|hey|yes|yeah|alright|now|also|please|actually)\b[,\s]*)+/i;
// A polite request or a stated want is his instruction, even phrased as a question.
const REQUEST=/^(?:(?:can|could|would|will)\s+(?:you|we)|we\s+should|you\s+(?:can|should|must|need\s+to|have\s+to|will|'ll))\s+(?:please\s+)?/i;
const WANT=/^(?:let(?:'s|\s+us)|(?:I|we)(?:'d|\s+would)?\s+(?:really\s+)?(?:want|need|like|prefer))\b/i;
// Words that cannot open an imperative clause: a clause starting with one is a remark
// ("I think Astra is overkill", "The Sol run failed") or an inquiry, not an instruction.
const NOT_IMPERATIVE=/^(?:i|i'm|i've|you|he|she|it|it's|we|they|this|that|these|those|there|the|a|an|my|your|our|his|its|their|is|are|was|were|am|be|been|has|had|does|did|should|shall|may|must|might|what|which|who|why|how|where|whose|or|and|no|yes)\b/i;
const NEGATION=/\b(?:not|never|no|nobody|neither|nor|avoid|stop|without|skip|except|disable|remove|ban|exclude|ignore|drop|block|forget|rule\s+out|lay\s+off)\b|n't\b|\bdont\b|\bdo\s+not\b/i;
// The name is the thing set aside, not the thing chosen ("Prefer Sol over Astra").
const SET_ASIDE=/\b(?:from|over|but|except|besides|instead\s+of|rather\s+than|other\s+than|than|replace|or|either)\s+(?:the\s+)?$/i;
const ALTERNATIVE=/^\s*(?:,\s*)?or\b/i;
const RETRACTED=/\b(?:never\s*mind|actually\s+no|or\s+not|maybe\s+not|scratch\s+that|forget\s+(?:it|that)|ignore\s+that)\b/i;
// A short next statement can take the previous one back ("Use Astra. Never mind.").
const RETRACTS_PREVIOUS=/^\s*(?:no|nope|never\s*mind|scratch\s+that|ignore\s+that|forget\s+(?:it|that)|actually,?\s+(?:no|don't)|(?:or\s+)?maybe\s+not|wait,?\s+no)\b/i;
// A condition or hedge makes it a rule for later, not a choice now ("if it fails, use Astra").
const CONDITION=/\b(?:if|unless|when|whenever|once|after|until|provided|assuming|in\s+case|in\s+the\s+event|maybe|perhaps|might|whether|should\s+(?:it|that|this)|otherwise|failing|fallback|last\s+resort|on\s+failure|upon|as\s+needed|next\s+time|later|eventually)\b/i;
const CLAUSE=/\s*[,:—–]\s*|\s+-\s+/;

/**
 * True when one of his statements asks, now and without negation, for the thing `mention`
 * finds. `after`, when given, must also be found later in that statement (ChatGPT's level).
 */
export function hisWordsChoose(words:string,mention:RegExp,after?:RegExp):boolean {
  const find=new RegExp(mention.source,mention.flags.replace('g',''));
  const all=statements(words.replace(/[’‘`]/g,"'"));
  return all.some((raw,position)=>{
    if(RETRACTS_PREVIOUS.test(all[position+1]??''))return false;
    let statement=raw.trim().replace(FILLER,'');
    const question=statement.endsWith('?');
    statement=statement.replace(/[.!?;]+$/,'');
    if(!find.test(statement)||CONDITION.test(statement))return false;
    const request=REQUEST.exec(statement);
    if(question&&!request)return false;
    if(request)statement=statement.slice(request[0].length);
    const want=WANT.test(statement);
    const clauses=statement.split(CLAUSE);
    return clauses.some((clause,index)=>{
      const body=clause.replace(FILLER,'');
      const found=find.exec(body);
      if(!found)return false;
      const pre=body.slice(0,found.index);
      const rest=[body.slice(found.index+found[0].length),...clauses.slice(index+1)].join(', ');
      // "Never, ever use Astra": a clause that is only "never" negates the next one; a lone
      // "No," answers what came before ("No, use Astra").
      const negatedBefore=index>0&&/^\s*(?:never|not\s+ever)\s*$/i.test(clauses[index-1]!);
      if(negatedBefore||NEGATION.test(pre)||SET_ASIDE.test(pre)||ALTERNATIVE.test(rest)||RETRACTED.test(rest))return false;
      // A remark has the name or a pronoun as its subject; a command starts with its verb.
      const instruction=(index===0&&(want||!!request))||(pre!==''&&!NOT_IMPERATIVE.test(body));
      return instruction&&(!after||after.test(rest));
    });
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

// A versioned mention ("GPT-6.1 Sol", "Sol 6.1", "Opus 5.5") names only that version; a bare
// name names any version. The model's own ID is a mention too.
function modelMention(model:string):RegExp|null {
  const escape=(text:string)=>text.replace(/[.*+?^${}()|[\]\\-]/g,'\\$&');
  const versioned=(name:string,version:string,prefix:string)=>new RegExp(
    `\\b${escape(model)}\\b|(?:\\b${prefix}\\s+${name}|(?<![\\w.-]|\\d\\s)${name})(?:\\s+\\(?v?${escape(version)}\\)?(?![\\d.]))?(?![\\w(]|\\s+\\(?v?\\d|-\\d)`,'i');
  const astra=/^gpt-([\d.]+)-astra$/i.exec(model);
  if(astra)return versioned('Astra',astra[1]!,`GPT-?\\s?${escape(astra[1]!)}`);
  const claude=/^claude-(fable|opus)-(\d+)-(\d+)/i.exec(model);
  if(claude)return versioned(claude[1]![0]!.toUpperCase()+claude[1]!.slice(1),`${claude[2]}.${claude[3]}`,'Claude');
  const sol=/^gpt-([\d.]+)-sol$/i.exec(model);
  if(sol)return versioned('Sol',sol[1]!,`GPT-?\\s?${escape(sol[1]!)}`);
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
  // The level must be said as a level, after ChatGPT in the statement that chooses it
  // ("Ask ChatGPT at extended thinking", "Ask ChatGPT Pro, on heavy", "Use ChatGPT high").
  const spoken=`(?:${SPOKEN_CHATGPT_LEVELS[effort]})\\b(?!-)`;
  const level=new RegExp(`^\\s+${spoken}|\\b(?:at|on|with|in|using)\\s+(?:its\\s+|the\\s+)?${spoken}|\\b${spoken}\\s+(?:thinking|effort|reasoning)\\b`,'i');
  return hisWordsChoose(human.words,/\bChatGPT\b/i,level);
}
