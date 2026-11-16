import type {ProviderUsage} from './provider-account-usage';
import {accountReadingFresh} from './account-allowance-observation';

/** Diagnostic only: no reads, writes, provider calls or changes to admission decisions. */
export function googleQuotaDisagreement(input:{model:string|null;account:string|null;runner:string|null;
  dispatchObservedAt:string;refusalAt:string;error:string;reading:ProviderUsage|null},now=Date.now()){
  const {reading}=input;
  const current=reading?.accounts.find(account=>account.current);
  const family=/^gemini-[\d.]+-([a-z]+)/.exec(input.model??'')?.[1];
  const knownModelFamily=family!==undefined&&['flash','pro','argon'].includes(family);
  const accountMatches=input.account&&current?.label?input.account.trim().toLowerCase()===current.label.trim().toLowerCase():null;
  const runnerMatches=reading?(input.runner??null)===(reading.sourceRunner??null):null;
  const label=family&&!['flash','pro'].includes(family)?family[0]!.toUpperCase()+family.slice(1):'Gemini';
  const relevant=current?.windows.filter(window=>window.name.startsWith(`${label} · `))??[];
  const required=label==='Gemini'?['Gemini · 5-hour','Gemini · weekly']:[];
  const readable=accountMatches===true&&runnerMatches===true&&knownModelFamily&&!!reading&&!!current&&accountReadingFresh('antigravity',reading,current,now)
    &&relevant.length>0&&required.every(name=>relevant.some(window=>window.name===name))
    &&relevant.every(window=>Number.isFinite(window.usedPercent)&&window.usedPercent>=0&&window.usedPercent<=100);
  const spent=relevant.filter(window=>window.usedPercent>=100);
  const assessment=!readable?'unavailable':spent.length?'exhausted':'room';
  const resets=spent.map(window=>Date.parse(window.resetsAt??'')).filter(at=>Number.isFinite(at)&&at>now);
  const resetAt=readable&&resets.length?new Date(Math.max(...resets)).toISOString():null;
  const evidence={account:input.account,model:input.model,runner:input.runner,dispatchObservedAt:input.dispatchObservedAt,
    accountIdentityBasis:'owner account selected at dispatch; CLI terminal does not attest account',refusalAt:input.refusalAt,
    assessment,resetAt,correspondence:{accountMatches,runnerMatches,knownModelFamily},
    reading:reading?{observedAt:reading.observedAt,sourceRunner:reading.sourceRunner??null,
      problem:reading.problem,account:current?.label??null,readAt:current?.readAt??null,
      accountProblem:current?.problem??null,windows:current?.windows??[]}:null};
  const description=assessment==='room'?'the post-refusal Google allowance reading reports room'
    :assessment==='exhausted'?resetAt?'the post-refusal Google reading reports exhaustion, but no reset was accepted for this turn'
      :'the post-refusal Google reading reports exhaustion without a usable reset'
      :'the post-refusal Google allowance reading is unavailable, incomplete or stale; room is unknown';
  return {evidence,text:`Google refused a turn for quota ("${input.error.slice(0,200)}") while ${description}. Find which allowance Google is enforcing and make the reading show it. Evidence: ${JSON.stringify(evidence)}`};
}
