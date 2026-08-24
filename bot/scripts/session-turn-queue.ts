import { resumeParkedSessionTurn } from "../src/state";

const [command, flag, rawTurnId, ...extra] = process.argv.slice(2);
if (command !== "resume" || flag !== "--turn-id" || !rawTurnId || extra.length > 0) {
  console.error("Usage: bun run bot/scripts/session-turn-queue.ts resume --turn-id <id>");
  process.exit(2);
}

const turnId = Number(rawTurnId);
if (!Number.isSafeInteger(turnId) || turnId <= 0) {
  console.error("Turn id must be a positive integer.");
  process.exit(2);
}

const result = resumeParkedSessionTurn(turnId);
console.log(`${result}: turn ${turnId}`);
if (result === "not_parked" || result === "unsafe") process.exit(1);
