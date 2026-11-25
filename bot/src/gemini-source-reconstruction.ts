import { createHash } from 'node:crypto';
import { verifySource, type CapabilitySource, type SourceRef } from './session-capability-client';

export const geminiReconstructionUnavailable =
  'The retained Gemini export does not establish conversation membership, speakers, order, a single revision path, complete exported bodies and accounted coverage.';

export function hasGeminiReconstructionProof(source: CapabilitySource | undefined, pin: SourceRef) {
  const proof = source?.reconstruction;
  return source?.provider === 'gemini' && source.synthetic === false
    && source.id === pin.sourceId && source.version === pin.sourceVersion && source.branch === pin.branch
    && proof?.packetVersion === 'gemini-export-dialogue-v1'
    && proof.sourceId === pin.sourceId && proof.sourceVersion === pin.sourceVersion && proof.branch === pin.branch
    && typeof proof.dialogueDigest === 'string' && /^[a-f0-9]{64}$/.test(proof.dialogueDigest);
}

export function geminiDialogue(source: CapabilitySource, pin: SourceRef) {
  verifySource(source, pin);
  if (!hasGeminiReconstructionProof(source, pin)) return null;
  const events = source.messages.map(({eventId, ordinal, role, locator, textHash, text}) =>
    ({eventId, ordinal, role, locator, textHash, text}));
  if (events.some((event, index) => event.ordinal !== index || event.role === 'tool' || !event.text.trim())
    || new Set(events.map(event => event.eventId)).size !== events.length
    || !events.some(event => event.role === 'user') || !events.some(event => event.role === 'assistant')) return null;
  const digest = createHash('sha256').update(JSON.stringify(events)).digest('hex');
  return digest === source.reconstruction!.dialogueDigest ? events : null;
}
