/** Emergency allowance hold for the 2026-11-05 weekly reset, 8 PM Eastern (EST). */
export const CLAUDE_ALLOWANCE_HOLD_UNTIL_MS=Date.parse('2026-11-06T01:00:00Z');

export function claudeAllowanceHeld(nowMs=Date.now()):boolean {
  // The authorized release fixtures use isolated /tmp ledgers and synthetic sessions;
  // they never start a provider. Keep their composition proof independent of this date.
  if(process.env.CONCIERGE_TEST_MODE==='1'
    &&(process.env.CONCIERGE_STATE_DIR??'').startsWith('/tmp/')
    &&['native-attribution-5eaa0768','responsive-system-b1eed622','foreground-isolation-5804d389','quiet-bank-e943db22']
      .includes(process.env.CONCIERGE_TEST_AUTHORIZATION??''))return false;
  return nowMs<CLAUDE_ALLOWANCE_HOLD_UNTIL_MS;
}

export const CLAUDE_ALLOWANCE_HOLD_MESSAGE='Claude starts are held until the weekly allowance resets at 8 PM Eastern on November 5. Choose another provider or retry then.';
