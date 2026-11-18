import {mock} from 'bun:test';
import assert from 'node:assert/strict';

let text='';
let retained:string[]=[];
mock.module('../src/session-inputs',()=>({
  getAcceptedSessionInput:(id:string)=>id==='human'?{id,origin:'human',payload_json:JSON.stringify({text})}
    :id==='peer'?{id,origin:'agent'}:null,
  sessionInputProvenance:()=>({originatingHuman:{inputId:'remote-human'},humanModelChoices:retained}),
}));
const {humanChoseThinkingModel,humanChoseTopModel,humanChoseProvider,humanChoseChatGptEffort}=await import('../src/model-escalation-custody');
const cases:[string,(id:string)=>boolean][]=[
  ['GPT-6.1 Sol',id=>humanChoseThinkingModel(id,'gpt-6.1-sol')],
  ['GPT-6 Astra',id=>humanChoseTopModel(id,'gpt-6-astra')],
  ['Codex',id=>humanChoseProvider(id,'codex')],
  ['ChatGPT high',id=>humanChoseChatGptEffort(id,'high')],
];
for(const [name,chosen] of cases){
  text=`Use ${name}.`;assert.equal(chosen('human'),true,text);
  for(const phrase of [`Should I use ${name}?`,`Use ${name}?`,`Use ${name} if needed.`,
    `If needed, use ${name}.`,`When needed, use ${name}.`,`Provided it is needed, use ${name}.`,
    `Assuming it is needed, use ${name}.`,`Maybe use ${name}.`,
    `Use ${name} only after three failed fixes and ChatGPT Pro has failed.`,
    `Once ChatGPT Pro has failed three times, use ${name}.`,`If needed,\nuse ${name}.`,
    `Don't use ${name}.`,`Do not use ${name} for this.`,`Never use ${name}.`,
    `${name} is too expensive.`,`I think ${name} is overkill.`,`Is ${name} better here?`]){
    text=phrase;assert.equal(chosen('human'),false,text);
  }
  for(const phrase of [`Can we discuss this? Use ${name}.`,`Could we use ${name}.`,`Could you use ${name}?`,
    `Ok, put ${name} on it.`,`I'd like you to use ${name}.`]){
    text=phrase;assert.equal(chosen('human'),true,text);
  }
}
// His sentences from the 2026-11-17 brittleness sweep: each is his choice, with no verb list.
for(const [phrase,chosen] of [
  ['Ask ChatGPT at extended thinking',()=>humanChoseChatGptEffort('human','high')&&humanChoseProvider('human','chatgpt')],
  ['Have Sol do it',()=>humanChoseThinkingModel('human','gpt-6.1-sol')&&humanChoseThinkingModel('human','gpt-6-sol')],
  ['Could you use Fable?',()=>humanChoseTopModel('human','claude-fable-5-2')],
  ['Get Astra on this',()=>humanChoseTopModel('human','gpt-6-astra')],
  ['Put Opus on it',()=>humanChoseThinkingModel('human','claude-opus-5-5')],
  ['I want Astra for this one',()=>humanChoseTopModel('human','gpt-6-astra')],
] as [string,()=>boolean][]){text=phrase;assert.equal(chosen(),true,phrase);}
for(const phrase of ["don't use Astra",'if it fails, use Astra','Use Sol, not Astra.']){
  text=phrase;assert.equal(humanChoseTopModel('human','gpt-6-astra'),false,phrase);
}
text='Ask ChatGPT at extended thinking';assert.equal(humanChoseChatGptEffort('human','light'),false);
// Review of the first sentence-shape rule: mentions that act on a model, set it aside or
// retract it are not his choice; a curly apostrophe still negates.
const astra=()=>humanChoseTopModel('human','gpt-6-astra');
// Mentions that merely act on a model ("Fix the Astra bug") are allowed to count: this check
// runs only when an agent is about to use that model, and a verb list cannot be completed.
for(const phrase of ['Don’t use Astra','Please don’t use Astra','Dont use Astra','Remove Astra from the list',
  'Disable Astra','Ban Astra','Use anything but Astra','Use Astra, never mind','Use Astra, actually no',
  'Switch from Astra to Sol','Switch to Sol from Astra','Replace Astra with Sol','Prefer Sol over Astra',
  'Use Sol over Astra','Use Sol rather than Astra','Is Astra worth it?','Astra, the expensive one, is overkill']){
  text=phrase;assert.equal(astra(),false,phrase);
}
for(const phrase of ["Don't use Sol, use Astra",'No, use Astra','Use Astra for this one','Let’s use Astra',
  'Run it on Astra','Use the Astra model','Use Astra and run tests','Use Astra but be careful',
  'Actually use Astra','Forget it, use Astra','Use Astra rather than Sol']){
  text=phrase;assert.equal(astra(),true,phrase);
}
for(const phrase of ['Switch from Astra to Sol','Switch to Sol from Astra','Replace Astra with Sol','Run this on Sol',
  'Use the Sol model','Use Sol only for this']){
  text=phrase;assert.equal(humanChoseThinkingModel('human','gpt-6.1-sol'),true,phrase);
}
for(const [phrase,provider] of [['Use ChatGPT Pro','chatgpt'],['Use Claude Code','claude-code'],['Use Codex CLI','codex'],
  ['Run on Codex','codex']]){text=phrase!;assert.equal(humanChoseProvider('human',provider!),true,phrase);}
for(const phrase of ['Ask ChatGPT, at extended thinking','Ask ChatGPT Pro at extended','Ask ChatGPT, on extended thinking']){
  text=phrase;assert.equal(humanChoseChatGptEffort('human','high'),true,phrase);
}
text='Ask ChatGPT for a high-level summary';assert.equal(humanChoseChatGptEffort('human','high'),false);
// Third review: unrecognized conditions, "neither", retraction in the next statement,
// set-aside verbs, alternatives and written versions.
for(const phrase of ['Should it fail, use Astra','Failing that, use Astra','Otherwise use Astra',
  'As a last resort use Astra','Use Astra as a fallback','Use Astra on failure','Use Astra upon failure',
  'Use Astra in the event it fails','Use Astra should it fail','Use Astra as needed','Use Astra later',
  'Next time use Astra','Use Sol, otherwise Astra','Neither Astra nor Sol','Use Astra. No.',
  'Use Astra. Never mind.','Use Astra. Actually, don’t.','Use Astra. Scratch that.','Use Astra. Ignore that.',
  'Use Astra. Or maybe not.','Use Sol and ignore Astra','Use Sol and drop Astra','Never, ever use Astra',
  'Nobody should use Astra','Exclude Astra','Rule out Astra','Use Sol or Astra','Use either Sol or Astra']){
  text=phrase;assert.equal(astra(),false,phrase);
}
for(const phrase of ['Neither Astra nor Sol','Use Sol or Astra']){
  text=phrase;assert.equal(humanChoseThinkingModel('human','gpt-6.1-sol'),false,phrase);
}
for(const phrase of ['Use Sol v6.1','Use Sol (6.1)']){
  text=phrase;assert.equal(humanChoseThinkingModel('human','gpt-6.1-sol'),true,phrase);
  assert.equal(humanChoseThinkingModel('human','gpt-6-sol'),false,phrase);
}
for(const phrase of ['We should use Astra','Keep using Astra','You should use Astra']){
  text=phrase;assert.equal(astra(),true,phrase);
}
text='Use Antigravity';assert.equal(humanChoseProvider('human','antigravity'),true);
text='Use Sol 6.1';assert.equal(humanChoseThinkingModel('human','gpt-6.1-sol'),true);
assert.equal(humanChoseThinkingModel('human','gpt-6-sol'),false);
text='Use gpt-6.1-sol';assert.equal(humanChoseThinkingModel('human','gpt-6.1-sol'),true);
text='Use Opus 4';assert.equal(humanChoseThinkingModel('human','claude-opus-5-5'),false);
text='Use Fable 4';assert.equal(humanChoseTopModel('human','claude-fable-5-2'),false);
text='Ask Codex at high effort and ChatGPT for review';assert.equal(humanChoseChatGptEffort('human','high'),false);
text='Use GPT-6.1 Sol.';
assert.equal(humanChoseThinkingModel('human','gpt-6-sol'),false);
text='Use GPT-6 Sol.';
assert.equal(humanChoseThinkingModel('human','gpt-6.1-sol'),false);
assert.equal(humanChoseThinkingModel('human','gpt-6-sol'),true);
text='Use GPT-6.1 Sol.';
assert.equal(humanChoseThinkingModel('peer','gpt-6.1-sol'),false);
retained=['gpt-6.1-sol'];assert.equal(humanChoseThinkingModel('peer','gpt-6.1-sol'),true);

// GPT-6.2: bare names and the current ids choose the current model; a version-qualified mention of another version does not.
const {CURRENT_ASTRA_MODEL,CURRENT_SOL_MODEL}=await import('../src/aliases');
for(const phrase of ['Use Sol','Have Sol do it','Use GPT-6.2 Sol','Use Sol 6.2',`Use ${CURRENT_SOL_MODEL}`]){
  text=phrase;assert.equal(humanChoseThinkingModel('human',CURRENT_SOL_MODEL),true,phrase);
}
for(const phrase of ['Use GPT-6.1 Sol','Use Sol 6.1','Use gpt-6.1-sol']){
  text=phrase;assert.equal(humanChoseThinkingModel('human',CURRENT_SOL_MODEL),false,phrase);
  assert.equal(humanChoseThinkingModel('human','gpt-6.1-sol'),true,phrase);
}
for(const phrase of ['Get Astra on this','Use GPT-6.2 Astra','Use Astra 6.2',`Use ${CURRENT_ASTRA_MODEL}`]){
  text=phrase;assert.equal(humanChoseTopModel('human',CURRENT_ASTRA_MODEL),true,phrase);
}
for(const phrase of ['Use GPT-6 Astra','Use gpt-6-astra']){
  text=phrase;assert.equal(humanChoseTopModel('human',CURRENT_ASTRA_MODEL),false,phrase);
  assert.equal(humanChoseTopModel('human','gpt-6-astra'),true,phrase);
}
console.log('human model, provider and effort choices reject questions and conditions');
