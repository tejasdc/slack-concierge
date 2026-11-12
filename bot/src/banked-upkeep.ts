import {db,getClaudePreferredModel,getSessionById} from './state';
import {sessionMetadata} from './session-inputs';
import {inspectSavedWork,noticeMissedQuietWindows,quietOnlyCutoff,reconsiderBankedWork,resumeBankedAfterYield,savedTurn,savedWorkSettings} from './saved-work';
import {quietOnlyAdmits} from './quiet-hours';
import {providerAccountUsage} from './provider-account-usage';
import {savedWorkAccountRooms} from './provider-account-dispatch';
import type {ActiveTurnDispatchRegistry} from './turn-dispatch-seams';
import {log,errorFields} from './log';

export type BankedYieldReason='allowance_boundary'|'deployment_boundary'|'quiet_boundary';

/**
 * Saved-work upkeep for whichever owner composition is running. Before 2026-11-12 only the
 * Slack-disabled composition (session-runtime.ts) called it, while the server runs the
 * Slack-enabled one (index.ts): banked work there was never given an account, so it never
 * started; its expiry alert never ran; and the quiet-only morning cutoff never stopped a run.
 * One home makes the two compositions unable to disagree again.
 */
export function createBankedUpkeep(input:{registry:()=>ActiveTurnDispatchRegistry}) {
  const active=new Set<number>();
  const yielding=new Map<number,BankedYieldReason>();
  let quietBoundaryTimer:ReturnType<typeof setTimeout>|null=null;
  const requestYield=(turnId:number,reason:BankedYieldReason)=>{
    if(yielding.has(turnId))return;
    const row=savedTurn(turnId);
    if(!row||row.saved_kind!=='banked'||row.saved_manual_start&&!row.saved_quiet_only)return;
    // Durable before the cancellation lands, so the request this run serves reads the cancellation
    // as a planned pause carried on by its continuation, not as the work being stopped.
    db.query("UPDATE turns SET saved_yield_reason=? WHERE id=? AND status IN ('running','delivering')").run(reason,turnId);
    const requested=input.registry().requestSessionCancellation(row.session_id,turnId);
    if(!requested.matched){db.query("UPDATE turns SET saved_yield_reason=NULL WHERE id=? AND status IN ('running','delivering')").run(turnId);return;}
    yielding.set(turnId,reason);
    void requested.completion.catch(error=>log('warn','banked_yield_failed',{turn_id:turnId,...errorFields(error)}));
  };
  const inspectActive=()=>{
    if(quietBoundaryTimer){clearTimeout(quietBoundaryTimer);quietBoundaryTimer=null;}
    const draining=!!db.query('SELECT 1 FROM deployment_drain WHERE singleton=1').get();
    const settings=savedWorkSettings(),reserve=settings.reserve_percent,now=Date.now();
    let nextQuietBoundary=Infinity;
    for(const turnId of active){
      const row=savedTurn(turnId);if(!row||row.saved_kind!=='banked'||row.saved_manual_start&&!row.saved_quiet_only)continue;
      if(yielding.has(turnId))continue;
      if(draining){requestYield(turnId,'deployment_boundary');continue;}
      if(row.saved_quiet_only){
        if(!quietOnlyAdmits(now,settings)){requestYield(turnId,'quiet_boundary');continue;}
        nextQuietBoundary=Math.min(nextQuietBoundary,quietOnlyCutoff(now,settings));
      }
      if(row.saved_manual_start)continue;
      const session=db.query('SELECT provider_id FROM sessions WHERE id=?').get(row.session_id) as {provider_id:string}|null;
      if(!session||!['codex','claude-code','antigravity'].includes(session.provider_id))continue;
      const provider=session.provider_id as 'codex'|'claude-code'|'antigravity';
      const usage=providerAccountUsage(provider);
      const account=usage?.accounts.find(item=>item.label===row.saved_account);
      const window=account?.windows.find(item=>item.name===row.saved_window);
      const owningSession=provider==='claude-code'?getSessionById(row.session_id):null;
      const model=provider==='claude-code'
        ?getClaudePreferredModel(row.session_id,row.id)??(owningSession?sessionMetadata(owningSession).model:null)??null:undefined;
      const room=usage?savedWorkAccountRooms(provider,usage,Date.now(),model).find(item=>item.account===row.saved_account):null;
      if(row.saved_boundary_ms!==null&&row.saved_boundary_ms<=Date.now()||
        !usage||!account||!room||room.problem||room.tightestUsedPercent===null||room.tightestUsedPercent>=100-reserve
        ||!window||window.usedPercent>=100-reserve)
        requestYield(turnId,'allowance_boundary');
    }
    if(Number.isFinite(nextQuietBoundary))quietBoundaryTimer=setTimeout(()=>inspectActive(),Math.max(1,nextQuietBoundary-Date.now()));
  };
  /** Each step runs on its own: one failing step must not silently skip the others. */
  const step=(name:string,work:()=>unknown)=>{
    try {work();} catch(error) {log('error','saved_work_upkeep_failed',{step:name,...errorFields(error)});}
  };
  /**
   * A planned pause whose continuation was never queued: the owner restarted between the
   * cancellation and settled(). Queue it now (or release the request if it cannot continue).
   */
  const recoverYields=()=>{
    const rows=db.query(`SELECT t.id,t.saved_yield_reason AS reason FROM turns t INDEXED BY banked_yields_awaiting
      WHERE t.saved_yield_reason IS NOT NULL AND t.status='cancelled'
        AND NOT EXISTS (SELECT 1 FROM session_inputs i WHERE i.id='turn-continuation:'||t.id)`).all() as {id:number;reason:BankedYieldReason}[];
    for(const row of rows)if(!yielding.has(row.id)&&!active.has(row.id))step('recover_yield',()=>resumeBankedAfterYield(row.id,row.reason));
  };
  return {
    inspectActive,
    stop(){if(quietBoundaryTimer){clearTimeout(quietBoundaryTimer);quietBoundaryTimer=null;}},
    hasActiveUnattendedBanked:()=>[...active].some(id=>{const saved=savedTurn(id);return saved?.saved_kind==='banked'&&!saved.saved_manual_start;}),
    started(turnId:number){active.add(turnId);step('inspect_active',inspectActive);},
    settled(turnId:number){
      active.delete(turnId);
      step('inspect_active',inspectActive);
      const reason=yielding.get(turnId);
      yielding.delete(turnId);
      if(reason)step('resume_after_yield',()=>resumeBankedAfterYield(turnId,reason));
    },
    recoverYields,
    /** After each usage reading. */
    onReading(){
      step('recover_yields',recoverYields);
      step('reconsider',()=>reconsiderBankedWork());
      step('inspect_saved',()=>inspectSavedWork());
      step('missed_quiet_windows',()=>noticeMissedQuietWindows());
      step('inspect_active',inspectActive);
    },
    /** After any execution change. */
    onExecutionChange(){
      step('reconsider',()=>reconsiderBankedWork());
      step('inspect_active',inspectActive);
    },
  };
}
