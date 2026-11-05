import {getAcceptedSessionInput,sessionInputProvenance} from './session-inputs';
import {topModel} from './model-escalation';

export function humanChoseTopModel(sourceInputId:string|undefined,model:string):boolean {
  if(!sourceInputId)return false;
  const source=getAcceptedSessionInput(sourceInputId);
  if(!source)return false;
  const humanId=source.origin==='human'?source.id:sessionInputProvenance(source)?.originatingHuman?.inputId;
  const human=humanId?getAcceptedSessionInput(humanId):null;
  if(!human||human.origin!=='human')return false;
  const words=JSON.parse(human.payload_json).text;
  if(typeof words!=='string')return false;
  const name=topModel(model)==='fable'?'fable':'astra';
  const directive=new RegExp(`\\b(?:use|choose|run|start|switch to|go with)\\s+(?:GPT-6\\s+)?${name}\\b`,'i');
  return words.split(/[.!?;\n]+/).some(clause=>{
    const match=directive.exec(clause);
    if(!match)return false;
    const before=clause.slice(0,match.index);
    return !/\b(?:not|never|avoid|don't|do not|stop|without|instead of|rather than|if|unless|maybe)\b/i.test(before)
      && !/\b(?:only if|only when|if necessary|when needed)\b/i.test(clause.slice(match.index+match[0].length));
  });
}
