import { log } from './log';

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
