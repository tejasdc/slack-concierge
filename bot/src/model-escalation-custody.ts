import {getAcceptedSessionInput,sessionInputProvenance} from './session-inputs';
import {topModel} from './model-escalation';

export function humanChoseTopModel(sourceInputId:string|undefined,model:string):boolean {
  if(!sourceInputId)return false;
  const source=getAcceptedSessionInput(sourceInputId);
  if(!source)return false;
  const humanId=source.origin==='human'?source.id:sessionInputProvenance(source)?.originatingHuman?.inputId;
  const human=humanId?getAcceptedSessionInput(humanId):null;
  if(!human||human.origin!=='human')return false;
  const words=JSON.stringify(JSON.parse(human.payload_json));
  const name=topModel(model)==='fable'?'fable':'astra';
  return new RegExp(`\\b(?:use|choose|run|start|switch to|with)\\b.{0,55}\\b${name}\\b`,'i').test(words);
}
