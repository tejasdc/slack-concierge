import assert from 'node:assert/strict';
import {notificationRequest} from '../src/session-notification-request';

export const notificationProbes=[
 'Fix the login bug and notify me when it is done',
 'Fix the login bug, notify me when it is done',
 'Fix this, and send me a notification when done',
 'Fix it and ping me once done',
];
const results=[...notificationProbes,
 'Fix the login bug, and notify me when it is done',
 'Also ping me when it is deployed.', 'Make sure to notify me.',
 'Ensure you notify me when done.', 'Make certain you notify me once installed.',
 'Fix the bug I mentioned and notify me when done',
 'Fix what I told you about, and ping me once done',
 'I want you to fix this and alert me afterward.',
 'Finish the work, then let me know when it is ready.',
 'Finish it and tell me once it is installed.',
 'Once you have finished this work, let me know.',
 'Can you notify me? If that monitoring is working, explain it.',
 'Could you please notify me when done?', 'When done, would you notify me?',
 'Why did the agent fail? Notify me here.',
 'What happened to the answer? Notify me with the outputs.',
 'Comprehensively fix that and notify me why this will never happen again.',
 'What the fuck not is this Notify me with the fucking link where I can go now',
 'Yeah, and I also notify me on, like, on this topic',
 'Do not restart it, but notify me when the analysis is ready.',
 'I changed the password, notify me once access works.',
 'I built the prototype, ping me when you finish checking it.',
 'You asked about the login bug, but notify me when it is fixed.',
 'You should notify me when it is done.', 'You must notify me when it is done.',
 'Please do not forget to notify me when done.', "Don't fail to ping me once done.",
];
const mentions=[
 'Did you notify me?', 'Why the fuck did you not notify me?', 'Will you notify me?',
 'Did you let me know when it finished?', 'Did you fix it and notify me?',
 'I asked you to let me know when done.', 'I asked you to fix and notify me when done.',
 'He said fix it and notify me once done.', 'She told you to ping me when done.',
 'He said, notify me when done.',
 'I forgot to notify me.', 'They would notify me when done.',
 'Do not notify me.', "Don't send me a notification.", 'Never ping me.',
 'Please do not let me know when it is done.',
 'You already notify me about that.', 'You were trying to notify me.',
 'You didn’t notify me.', "You didn't notify me.", 'You did not notify me.',
 'Why do you notify me with this?', 'Why would you notify me?',
 'The note says "notify me when done".', '"Let me know once done"',
 'He said “ping me when done”.', '> Let me know when done',
 'Maybe notify me is the right command.', 'Maybe notify me is the only thing that notifies me.',
 'I was criticizing the session about the notify me design.',
 "When they say, okay, we're going to only use notify me from now, add a flashcard.",
 'We change that system to answer me or notify me whenever I ask for an answer.',
 "You don't know that you have to notify me, this system is broken.",
 'If you still need my help, send me a notification.', 'If you need my help then notify me.',
 'What happened?', 'Let me know how it works.', 'Tell me when is the best time.',
 'Keep this note.\nComplete diagnostics JSON\n{"text":"notify me"}',
];
for(const words of results)assert.equal(notificationRequest(words),'result',words);
for(const words of mentions)assert.equal(notificationRequest(words),null,words);
assert.equal(notificationRequest('Remind me tomorrow to check this.'),'scheduled');
assert.equal(notificationRequest('Do not remind me tomorrow.'),null);
assert.equal(notificationRequest('He said "remind me tomorrow".'),null);
console.log(JSON.stringify({fixture:'notification-request-invariant',results:results.length,excluded:mentions.length,reminderPreserved:true}));
