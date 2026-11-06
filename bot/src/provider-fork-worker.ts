import {forkSession,getSessionMessages} from '@anthropic-ai/claude-agent-sdk';

const [sessionUuid,boundary]=process.argv.slice(2);
if(!sessionUuid||!boundary)throw new Error('PROVIDER_FORK_IDENTITY_REQUIRED');
const dir=process.cwd();
const rows=await getSessionMessages(sessionUuid,{dir});
if(!rows.some(row=>row.session_id===sessionUuid&&row.uuid===boundary))throw new Error('PROVIDER_FORK_BOUNDARY_NOT_FOUND');
const result=await forkSession(sessionUuid,{dir,upToMessageId:boundary});
if(!result.sessionId||result.sessionId===sessionUuid)throw new Error('PROVIDER_FORK_IDENTITY_MISMATCH');
process.stdout.write(JSON.stringify({sessionUUID:result.sessionId}));
