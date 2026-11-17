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
text='Use GPT-6.1 Sol.';
assert.equal(humanChoseThinkingModel('human','gpt-6-sol'),false);
text='Use GPT-6 Sol.';
assert.equal(humanChoseThinkingModel('human','gpt-6.1-sol'),false);
assert.equal(humanChoseThinkingModel('human','gpt-6-sol'),true);
text='Use GPT-6.1 Sol.';
assert.equal(humanChoseThinkingModel('peer','gpt-6.1-sol'),false);
retained=['gpt-6.1-sol'];assert.equal(humanChoseThinkingModel('peer','gpt-6.1-sol'),true);
console.log('human model, provider and effort choices reject questions and conditions');
