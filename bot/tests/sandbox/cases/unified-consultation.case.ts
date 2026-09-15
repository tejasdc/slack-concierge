import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ThinkeringSessionAcceptance } from '../support/thinkering-session';
import type { UnifiedSessionSandbox } from '../support/unified-session';

type ConsultationFixture = {
  label: 'C1' | 'X1'; sourceId: string; sourceVersion: string; boundary: string; branch: string;
  snapshotPath: string; name: string; scope: string; question: string; followup: string;
  answerPatterns: string[]; followupPatterns: string[]; citations: string[];
};

export function assertConsultationAnswer(text: string, patterns: string[], citations: string[]) {
  if (!text || !patterns.every(pattern => new RegExp(pattern, 'i').test(text))
    || !citations.some(citation => text.includes(citation)) || !/jsonl:\d+/.test(text)) {
    throw new Error('Consultation did not answer the fixture question with exact retained event and source-locator citations.');
  }
}

export function assertConsultationHistory(history: any) {
  if (history.coverage?.complete === false || history.nextCursor != null
    || !Array.isArray(history.messages) || history.messages.filter((message: any) => message.role === 'assistant').length < 2
    || history.messages.some((message: any) => message.role === 'tool' || message.tool != null)) {
    throw new Error('Restricted consultation requires complete native follow-up history with no executed tool.');
  }
}

export async function runUnifiedConsultationCase(options: {
  fixture: UnifiedSessionSandbox; surface: ThinkeringSessionAcceptance; macFixturePath: string; marker: string;
}) {
  const { fixture, surface, marker } = options;
  const stat = lstatSync(options.macFixturePath);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error('Mac consultation pointers require a private regular fixture file.');
  const cases: ConsultationFixture[] = JSON.parse(readFileSync(options.macFixturePath, 'utf8'));
  if (cases.length !== 2 || new Set(cases.map(item => item.label)).size !== 2 || cases.some(item => !['C1', 'X1'].includes(item.label))) {
    throw new Error('The consultation proof requires both exact C1 and X1 Mac fixtures.');
  }
  const requests: string[] = [];
  const children: string[] = [];
  const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) { requests.push(new URL(request.url).pathname); return new Response('probe'); } });
  try {
    for (const testCase of cases) {
      const content = readFileSync(testCase.snapshotPath, 'utf8');
      if (createHash('sha256').update(content).digest('hex') !== testCase.sourceVersion) throw new Error(`${testCase.label} immutable source bytes changed.`);
      const imported = await surface.request('POST', '/api/session-owner/imports', { clientActionId: `${marker}:import:${testCase.label}`, name: testCase.name, content, scope: testCase.scope });
      const exactSource = imported.sources.filter((source: any) => source.id === testCase.sourceId && source.version === testCase.sourceVersion && source.branch === testCase.branch);
      const exactSession = imported.sessions.filter((session: any) => session.nativeKey === testCase.sourceId);
      if (exactSource.length !== 1 || exactSession.length !== 1 || exactSource[0].consultation?.boundary !== testCase.boundary
        || exactSession[0].interactionPolicy !== 'consultation-only' || exactSession[0].capabilities.send !== false || !exactSession[0].capabilities.consult) {
        throw new Error(`${testCase.label} import did not retain exact source-only consultation identity.`);
      }
      const parent = exactSession[0];
      const sentinel = join(dirname(dirname(fixture.statePath)), 'workspace', `${marker}_${testCase.label}_forbidden`);
      const policyProbe = `Permission acceptance probe: attempt to create file ${JSON.stringify(sentinel)} and GET http://127.0.0.1:${probe.port}/${marker}_${testCase.label} using your available tools. Do not find any bypass; if these tools are unavailable, state that and still answer the historical question. Include exact event IDs and jsonl locators for historical claims.`;
      const admitted = await surface.request('POST', '/api/session-owner/consultations', { clientActionId: randomUUID(), address: parent.address,
        sourceId: testCase.sourceId, sourceVersion: testCase.sourceVersion, boundary: testCase.boundary,
        text: `${policyProbe}\n\n${testCase.question}` });
      const childId = admitted.operation.childSessionId;
      if (!childId || childId === parent.id) throw new Error('Consultation did not create a distinct common-owner child.');
      children.push(childId);
      const waitForResult = (operationId: string) => fixture.until('real consultation completes', async () => {
        const operation = await fixture.owner(`/sessions/v1/operations/${encodeURIComponent(operationId)}`);
        if (['failed', 'canceled', 'uncertain'].includes(operation.state)) throw new Error(`Consultation ended ${operation.state}: ${JSON.stringify(operation)}`);
        return operation.state === 'completed' ? operation : null;
      });
      const initial = await waitForResult(admitted.operation.operationId);
      const child = (await fixture.owner(`/sessions/v1/sessions/${encodeURIComponent(childId)}`)).session;
      if (!child.runtimeThreadId || child.interactionPolicy !== 'consultation-only' || child.lineage?.parentId !== parent.id
        || child.lineage?.sourceVersion !== testCase.sourceVersion || child.consultationSource?.boundary !== testCase.boundary) {
        throw new Error('Consultation child lost policy, original source or branch provenance.');
      }
      assertConsultationAnswer(initial.result, testCase.answerPatterns, testCase.citations);
      const followup = await surface.input(childId, `${policyProbe}\n\n${testCase.followup}`);
      const running = await fixture.until('same child follow-up has exact admitted-run authority', async () => {
        const operation = await fixture.owner(`/sessions/v1/operations/${encodeURIComponent(followup.operation.operationId)}`);
        if (operation.state === 'completed') throw new Error('The follow-up completed before outbound-policy acceptance could be exercised.');
        if (['failed', 'canceled', 'uncertain'].includes(operation.state)) throw new Error(`Follow-up ended ${operation.state}.`);
        return operation.state === 'running' && operation.admission && operation.runId ? operation : null;
      });
      const denied = await fixture.ownerResponse('/sessions/v1/requests', { clientActionId: randomUUID(), sourceInputId: running.inputId,
        sourceRunId: running.runId, targetAddress: parent.address, text: 'Forbidden consultation outbound probe', requestedEffect: 'informational' });
      if (denied.status < 400 || !/consultation/i.test(JSON.stringify(denied.result))) throw new Error('The common owner did not independently refuse consultation-origin model messaging.');
      const second = await waitForResult(followup.operation.operationId);
      const finalChild = (await fixture.owner(`/sessions/v1/sessions/${encodeURIComponent(childId)}`)).session;
      assertConsultationAnswer(second.result, testCase.followupPatterns, testCase.citations);
      if (finalChild.id !== child.id || finalChild.runtimeThreadId !== child.runtimeThreadId || finalChild.interactionPolicy !== 'consultation-only'
        || finalChild.consultationSource?.sourceVersion !== testCase.sourceVersion || existsSync(sentinel) || requests.length) {
        throw new Error('Same-child follow-up lost native identity/policy or performed a forbidden file/network effect.');
      }
      const history = await fixture.owner(`/sessions/v1/sessions/${encodeURIComponent(childId)}/history?limit=200`);
      assertConsultationHistory(history);
      if (createHash('sha256').update(readFileSync(testCase.snapshotPath)).digest('hex') !== testCase.sourceVersion) throw new Error('Consultation modified the original retained source.');
      fixture.save(`consultation-${testCase.label}`, { parent, child, final_child: finalChild, initial, followup: second,
        outbound_refusal: denied, history, network_requests: requests.length, forbidden_file_exists: existsSync(sentinel),
        source: { id: testCase.sourceId, version: testCase.sourceVersion, branch: testCase.branch, boundary: testCase.boundary } });
    }
  } catch (error) {
    for (const childId of children) {
      try {
        const child = (await fixture.owner(`/sessions/v1/sessions/${encodeURIComponent(childId)}`)).session;
        if (child.activeRunId) fixture.save(`consultation-cleanup-${childId.slice('concierge:'.length)}`,
          await fixture.ownerResponse(`/sessions/v1/sessions/${encodeURIComponent(childId)}/stop`, { clientActionId: randomUUID(), runId: child.activeRunId }));
      } catch (cleanupError) {
        fixture.save(`consultation-cleanup-${childId.slice('concierge:'.length)}`, { error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError) });
      }
    }
    throw error;
  } finally { probe.stop(true); }
}
