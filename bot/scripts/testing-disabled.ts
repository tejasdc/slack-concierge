// Scoped human exception: original Thinkering report 5eaa0768 requests native
// multi-agent testing and review. Test preload still owns isolated storage.
if(process.env.CONCIERGE_TEST_AUTHORIZATION!=='native-attribution-5eaa0768'){
 process.stderr.write('Agent-run tests and Slack sandboxes are disabled by Tejas (1789490492.818709). End-to-end testing belongs to the user.\n');
 process.exit(1);
}
