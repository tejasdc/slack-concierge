/** Runner-local provider prerequisites. Each method returns only an executable fact, never a token. */
import { antigravityExecutable } from './antigravity';

export async function serveRunnerProviderCall(method:string,_params:Record<string,unknown>):Promise<unknown> {
  if(method==='google.executable')return {executable:antigravityExecutable()};
  throw new Error(`Unknown runner provider operation: ${method}`);
}
