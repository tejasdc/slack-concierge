import {test,expect} from 'bun:test';
import {SessionOwner} from '../src/session-owner';
import {ownerRequestLabel} from '../src/owner-request-label';

test('actual owner completion lines retain operation templates without private identity',async()=>{
 const owner=new SessionOwner({wake(){},available(){return false;},steer(){return false;},async stop(){return false;}},'/tmp');
 const observed:string[]=[];const original=console.log;
 console.log=(...args:unknown[])=>{if(typeof args[0]==='string'&&args[0].includes('owner_request_completed'))observed.push(args[0]);};
 const samples=[
  ['POST','/sessions/concierge%3A918273/inputs','send'],
  ['POST','/sessions/concierge%3A918273/stop','stop'],
  ['GET','/presentation/sessions/window','sessions'],
  ['GET','/presentation/sessions/changes','sessions'],
  ['GET','/presentation/receipts/concierge%3A918273/changes','receipts'],
  ['GET','/presentation/topic-details/'+'a'.repeat(64),'thread'],
  ['GET','/presentation/topics/topic%3Aprivate-sentinel','thread'],
  ['GET','/sessions/concierge%3A918273/history','history'],
  ['GET','/auth/providers','accounts'],
  ['POST','/search','search'],
  ['GET','/attachments/private-sentinel/transcription','transcription'],
 ] as const;
 try{
  for(const [method,path] of samples)await owner.handle(new Request('http://owner/sessions/v1'+path+'?private=SECRET_SENTINEL',{method,...(method==='POST'?{body:'{}',headers:{'content-type':'application/json'}}:{})}));
 }finally{console.log=original;}
 expect(observed).toHaveLength(samples.length);
 for(const line of observed){expect(line).not.toContain('918273');expect(line).not.toContain('private-sentinel');expect(line).not.toContain('SECRET_SENTINEL');}
 expect(JSON.parse(observed[0]!).route).toBe('POST /sessions/v1/sessions/:id/inputs');
 expect(JSON.parse(observed[1]!).route).toBe('POST /sessions/v1/sessions/:id/stop');
 expect(JSON.parse(observed[2]!).route).toBe('GET /sessions/v1/presentation/sessions/window');
 expect(ownerRequestLabel('GET','/sessions/v1/private-arbitrary-project')).toBe('GET /sessions/v1/:unknown');
 const destination=process.env.OWNER_MONITOR_FIXTURE;
 if(destination)await Bun.write(destination,observed.map((line,i)=>JSON.stringify({...JSON.parse(line),fixture_expected_family:samples[i]![2]})).join('\n')+'\n');
});
