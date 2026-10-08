/** Shared decisions for both the canonical topic owner and its prepared read model. */
export const OPEN_QUESTION_STATES=['open','partial'] as const;
export type QuestionKind='decision'|'reading';
export type QuestionOrigin='declared'|'marker'|'recovered';
export function briefMissing(brief:any):string[]{
 const missing:string[]=[];
 if(!String(brief?.decision??'').trim())missing.push('decision');
 if(!String(brief?.why?.text??'').trim())missing.push('why');
 if(!String(brief?.answerable??'').trim())missing.push('answerable');
 if(Array.isArray(brief?.choices)&&brief.choices.some((choice:any)=>!String(choice?.label??'').trim()))missing.push('choices[].label');
 return missing;
}
export const missingFor=(question:{brief:any;origin?:QuestionOrigin}):string[]=>question.origin==='marker'
 ?(String(question.brief?.decision??'').trim()?[]:['decision']):briefMissing(question.brief);
export const questionReadiness=(question:{context:string;brief:any;origin?:QuestionOrigin}):'ready'|'preparing'=>
 question.context==='ready'&&!missingFor(question).length?'ready':'preparing';
export const awaitingHim=(question:{state:string;context:string;brief:any;blocking:boolean;optional:boolean;pendingReply?:any;kind?:QuestionKind})=>
 (question.kind??'decision')==='decision'&&OPEN_QUESTION_STATES.some(state=>state===question.state)
 &&questionReadiness(question)==='ready'&&(question.blocking||!question.optional)&&!question.pendingReply;
export const toReadByHim=(question:{state:string;kind?:QuestionKind;reads?:readonly unknown[]})=>
 question.kind==='reading'&&OPEN_QUESTION_STATES.some(state=>state===question.state)&&!!question.reads?.length;
export const preparingForHim=(question:{state:string;context:string;brief:any;kind?:QuestionKind})=>
 (question.kind??'decision')==='decision'&&OPEN_QUESTION_STATES.some(state=>state===question.state)
 &&questionReadiness(question)==='preparing';
