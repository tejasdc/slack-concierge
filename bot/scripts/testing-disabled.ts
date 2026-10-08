// Scoped human exception: original Thinkering report 5eaa0768 requests native
// multi-agent testing and review. Test preload still owns isolated storage.
// Tejas's Oct 7 investigation and Oct 8 implementation explicitly authorize isolated
// responsiveness/lifecycle checks; neither exception permits production storage.
if(!['native-attribution-5eaa0768','responsive-system-b1eed622'].includes(process.env.CONCIERGE_TEST_AUTHORIZATION??'')){
 process.stderr.write('Agent-run tests and Slack sandboxes are disabled by Tejas (1789490492.818709). End-to-end testing belongs to the user.\n');
 process.exit(1);
}
