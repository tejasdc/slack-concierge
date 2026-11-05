import { log } from './log';
import { withTaskLabel } from './owner-task-labels';
import { measureStorageStep, type StorageStep } from './storage-interval';

type StepEvent = { step: string; status: 'completed' | 'failed'; ms: number; uptime_ms: number; storage: StorageStep };
const logStep = (event: StepEvent) => log(event.status === 'failed' ? 'error' : 'info', 'concierge_startup_step', event);

/**
 * One synchronous startup step, timed and named. The step runs under its own watchdog label, so a
 * block it causes is attributed to it in owner_task_blocked, and its line carries its wall time,
 * its ledger statements and its slowest statement's fingerprint. Before this a 126 s start named
 * only "startup" (incident ce2c2192, 2026-11-05).
 */
export function runStartupStep<T>(step: string, work: () => T, observe: (event: StepEvent) => void = logStep): T {
  const start = performance.now();
  let measured: { result: T; storage: StorageStep } | null = null;
  try {
    measured = withTaskLabel(`startup ${step}`, () => measureStorageStep(work));
    return measured.result;
  } finally {
    observe({ step, status: measured ? 'completed' : 'failed', ms: Math.round(performance.now() - start),
      uptime_ms: Math.round(process.uptime() * 1000),
      storage: measured?.storage ?? { calls: 0, occupied_ms: 0, slowest_ms: 0, slowest_fingerprint: null } });
  }
}

/** The span before the first step: process start to the owner's body, including every module's import-time work. */
export function recordModuleLoadStep(storage: StorageStep, observe: (event: StepEvent) => void = logStep) {
  const uptime = Math.round(process.uptime() * 1000);
  observe({ step: 'module_load', status: 'completed', ms: uptime, uptime_ms: uptime, storage });
}

type StartupPhase = 'recovery' | 'canvas_refresh' | 'slack_connection' | 'request_api' | 'capture_worker' | 'provider_readiness';
type PhaseEvent = { phase: StartupPhase; status: 'started' | 'completed' | 'failed' };

/** Record the awaited boundary without logging credentials or captured content. */
export async function runStartupPhase<T>(
  phase: StartupPhase,
  start: () => T | Promise<T>,
  observe: (event: PhaseEvent) => void = event => log(
    event.status === 'failed' ? 'error' : 'info', 'concierge_startup_phase', event,
  ),
): Promise<T> {
  observe({ phase, status: 'started' });
  try {
    const result = await start();
    observe({ phase, status: 'completed' });
    return result;
  } catch (error) {
    observe({ phase, status: 'failed' });
    throw error;
  }
}
