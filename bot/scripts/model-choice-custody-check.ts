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
console.log('human model, provider and effort choices reject questions and conditions');
