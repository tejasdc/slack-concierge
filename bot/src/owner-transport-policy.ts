/** Existing router command allowance, shared with the forwarding boundary. */
export const OWNER_COMMAND_RESPONSE_MS=120_000;
/** Existing peer read allowance; queueing does not grant a second allowance. */
export const OWNER_READ_RESPONSE_MS=20_000;
/** Connection errors that prove a request never reached the owner (no socket file, nothing
 * listening), so sending it again cannot apply it twice. Bun names them FailedToOpenSocket and
 * ConnectionRefused; Node names them ENOENT and ECONNREFUSED. */
export const OWNER_NEVER_REACHED_CODES:ReadonlySet<string>=new Set(['FailedToOpenSocket','ECONNREFUSED','ENOENT','ConnectionRefused']);
export const ownerNeverReached=(error:unknown)=>OWNER_NEVER_REACHED_CODES.has(String((error as {code?:unknown})?.code??''));
