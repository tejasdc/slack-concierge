#!/usr/bin/env bun
import {requestApiResponse} from './router-request-client';

const usage='router-actions.sh reports chain <accepted-input-or-request-id> | capture <captureId> | window <since-UTC> <until-UTC>';
const [verb,...args]=process.argv.slice(2);
let path:string;
if(verb==='chain'&&args.length===1&&/^[A-Za-z0-9:_-]{1,128}$/.test(args[0]!))
  path=`/sessions/v1/reports/chain/${encodeURIComponent(args[0]!)}`;
// A request cites his capture by ID; the recipient reads its exact words here, at any age and from any Inbox.
else if(verb==='capture'&&args.length===1&&/^(capture:)?[a-f0-9]{64}$/.test(args[0]!))
  path=`/sessions/v1/inbox/${args[0]!.replace(/^capture:/,'')}`;
else if(verb==='window'&&args.length===2&&args.every(value=>/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value)))
  path='/sessions/v1/reports/window?'+new URLSearchParams({since:args[0]!,until:args[1]!});
else {console.error(usage);process.exit(2);}
const answer=await requestApiResponse(path);
if(!answer.ok){console.error(JSON.stringify(answer.result));process.exit(1);}
console.log(JSON.stringify(answer.result));
