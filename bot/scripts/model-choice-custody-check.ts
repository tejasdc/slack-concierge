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
    `Assuming it is needed, use ${name}.`,`Maybe use ${name}.`,`Could we use ${name}.`,
    `Use ${name} only after three failed fixes and ChatGPT Pro has failed.`,
    `Once ChatGPT Pro has failed three times, use ${name}.`,`If needed,\nuse ${name}.`]){
    text=phrase;assert.equal(chosen('human'),false,text);
  }
  text=`Can we discuss this? Use ${name}.`;assert.equal(chosen('human'),true,text);
}
text='Use GPT-6.1 Sol.';
assert.equal(humanChoseThinkingModel('human','gpt-6-sol'),false);
assert.equal(humanChoseThinkingModel('peer','gpt-6.1-sol'),false);
retained=['gpt-6.1-sol'];assert.equal(humanChoseThinkingModel('peer','gpt-6.1-sol'),true);
console.log('human model, provider and effort choices reject questions and conditions');
