/**
 * Which text messages are keys to one of Tejas's accounts: a one-time code, a password reset or
 * account-recovery text, or a sign-in link. Agents never see those words (his 2026-10-07 security
 * note: "someone can … ask my agents … give me the code that we they just received from thy
 * message"); they are told one was withheld, from whom and when, so nothing reads as complete.
 *
 * It errs toward withholding: an automated sender (a short code or a named sender, never a phone
 * number or an address) with any 4–8 digit run is treated as a code, because a missed code is the
 * failure that matters and a withheld coupon costs nothing. thnkr.ing's mail rule (its
 * mail-withholding module) is the email half; texts read differently, so this one is written for
 * text shapes: "123456 is your Venmo code", "G-123456", Apple's "@site.com #123456".
 */
export type TextWithholdingKind = 'one-time code' | 'password reset' | 'sign-in link';

// Words that make a number a key, for senders that look like people (banks also text from ordinary
// and toll-free numbers). Deliberately not "confirm" or "access": "confirm 7:30 at 1234 Main St"
// is not a code. An automated sender's digits are withheld whatever the words.
const CODE_WORDS = /\b(?:code|passcode|otp|one[- ]?time|verification|verify|security code|2fa|two[- ]?factor|2-step|two[- ]step|pin|password|log[- ]?in|sign[- ]?in|token|authenticat\w*|confirmation (?:code|number))\b/i;
// A 4–8 digit run (optionally "G-" prefixed) that is not part of a longer number, an amount or a
// decimal. A colon or comma right beside it is ordinary in codes ("code:482913", "4829, do not share").
const CODE_TOKEN = /(?<![\d$.,/])(?:[A-Z]{1,3}-)?\d{4,8}(?!\d|[.,]\d)|\b\d{3}[- ]\d{3}\b/;
const DOMAIN_BOUND = /@[\w-]+(?:\.[\w-]+)+\s+#[\w-]{4,12}/;
const RESET = /\b(?:reset|recover(?:y)?|unlock|forgot)\b[\s\S]{0,80}\b(?:password|passcode|account|pin|log[- ]?in|apple id)\b|\b(?:password|passcode|pin)\b[\s\S]{0,40}\b(?:reset|changed|change|recovery)\b/i;
const LINK = /https?:\/\/\S+|\b[\w-]+\.(?:com|io|app|co|me|net|org)\/\S+/i;
const SIGN_IN = /\b(?:sign|log)[- ]?in\b|\bmagic link\b|\bverify\b|\bconfirm\b|\bapprove\b/i;
// A link whose address is itself a sign-in, verify or reset step, from any sender: banks also text
// these from ordinary and toll-free numbers.
// Beside a link, these words make it a sign-in or reset link from any sender ("Click here to log
// in: https://foo.com/l/abc"); the softer "confirm" or "approve" count only from automated senders.
const SIGN_IN_OR_RESET = /\b(?:sign|log)[- ]?in\b|\bmagic link\b|\breset\b|\bverify\b/i;
const AUTH_LINK =/https?:\/\/\S*(?:log-?in|sign-?in|verify|reset|magic|auth(?:enticate)?\b|token|otp\b)\S*/i;

/** A short code ("22395") or a named sender ("Chase"), as opposed to a person's number or address. */
export function isAutomatedSender(handle: string | null | undefined): boolean {
  const value = (handle ?? '').trim();
  if (!value || value.includes('@')) return false;
  if (/^\+?\d[\d\s().-]{8,}$/.test(value)) return false;
  return /^\d{3,7}$/.test(value) || /^[A-Za-z][\w .&'-]{0,20}$/.test(value);
}

/** Why a text must be withheld from agents, or null when its words may be shown. */
export function textWithholding(text: string | null | undefined, sender: string | null | undefined): TextWithholdingKind | null {
  const words = (text ?? '').trim();
  if (!words) return null;
  if (DOMAIN_BOUND.test(words)) return 'one-time code';
  if (RESET.test(words)) return 'password reset';
  const token = CODE_TOKEN.test(words);
  if (token && (CODE_WORDS.test(words) || isAutomatedSender(sender))) return 'one-time code';
  if (AUTH_LINK.test(words)) return 'sign-in link';
  if (LINK.test(words) && (SIGN_IN_OR_RESET.test(words) || (SIGN_IN.test(words) && isAutomatedSender(sender)))) return 'sign-in link';
  return null;
}
