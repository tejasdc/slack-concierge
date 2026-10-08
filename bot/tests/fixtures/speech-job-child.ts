import {processSpeechJob} from '../../src/speech-job-worker';
import {pendingSpeechJobs,speechRoot} from '../../src/speech-job-spool';

const id=process.argv[2];
const root=speechRoot(process.env.CONCIERGE_STATE_DIR!);
const job=pendingSpeechJobs(root).find(item=>item.attachmentId===id);
if(!job)throw new Error('The child could not find the durable speech job.');
await processSpeechJob(job,async input=>({
 slackFileId:input.slackFileId,title:input.title,text:'words from separate worker process',source:'parakeet',audioMs:100,
}));
