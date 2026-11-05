/** Emergency allowance hold for the 2026-11-05 weekly reset, 8 PM Eastern (EST). */
export const CLAUDE_ALLOWANCE_HOLD_UNTIL_MS=Date.parse('2026-11-06T01:00:00Z');

export function claudeAllowanceHeld(nowMs=Date.now()):boolean {
  return nowMs<CLAUDE_ALLOWANCE_HOLD_UNTIL_MS;
}

export const CLAUDE_ALLOWANCE_HOLD_MESSAGE='Claude starts are held until the weekly allowance resets at 8 PM Eastern on November 5. Choose another provider or retry then.';
