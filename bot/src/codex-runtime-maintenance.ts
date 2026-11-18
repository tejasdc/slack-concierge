import {isProcessIdentity,type ProcessIdentity} from './runtime-identity';

export type RuntimeMaintenanceBinding={operationId:string;sourceInputId:string;sourceRunId:string;actionId:string;requiredCommit:string};
export type RuntimeMaintenanceState={binding:RuntimeMaintenanceBinding;phase:'waiting'|'draining'|'starting'|'applied'|'uncertain';
  original?:ProcessIdentity;replacement?:ProcessIdentity;detail?:string};
export type RuntimeSnapshot={identity:ProcessIdentity;masked:boolean;supported:boolean};
export type RuntimeMaintenanceObservation={applied:RuntimeMaintenanceState|null;verified:boolean;persisted:boolean;detail?:string};
export type RuntimeMaintenanceServices={
  persist():void; snapshot():Promise<RuntimeSnapshot|null>; alive(identity:ProcessIdentity):boolean;
  nativeIdle():Promise<boolean>; signal(identity:ProcessIdentity):void; start():Promise<void>;
  prove(identity:ProcessIdentity):Promise<void>;
};
export function sameRuntime(a:unknown,b:unknown){return isProcessIdentity(a)&&isProcessIdentity(b)&&a.pid===b.pid&&a.bootId===b.bootId&&a.startTicks===b.startTicks;}
export function sameRuntimeMaintenanceBinding(a:RuntimeMaintenanceBinding,b:RuntimeMaintenanceBinding):boolean{
  return (['operationId','sourceInputId','sourceRunId','actionId','requiredCommit'] as const).every(key=>a?.[key]===b?.[key]);
}

/** Historical completion never authorizes another drain, including when current health changed. */
export async function observeAppliedRuntimeMaintenance(state:RuntimeMaintenanceState|undefined,
  services:Pick<RuntimeMaintenanceServices,'snapshot'|'prove'>):Promise<Omit<RuntimeMaintenanceObservation,'persisted'>>{
  if(state?.phase!=='applied')return {applied:null,verified:false};
  const applied=structuredClone(state);
  try{
    const replacement=applied.replacement;
    if(!replacement)throw new Error('The retained applied operation has no exact replacement generation.');
    const before=await services.snapshot();
    if(!before?.masked||!sameRuntime(before.identity,replacement))throw new Error('The retained replacement is missing, changed or no longer masked.');
    await services.prove(replacement);
    const after=await services.snapshot();
    if(!after?.masked||!sameRuntime(after.identity,replacement))throw new Error('The retained replacement changed during provider proof.');
    return {applied,verified:true};
  }catch(error){return {applied,verified:false,detail:error instanceof Error?error.message:String(error)};}
}

/** One retry-safe progress step. SIGHUP is graceful-only in the explicitly supported runtime.
 * Intent is durable before signal, and redelivery to that exact generation cannot force it. */
export async function progressRuntimeMaintenance(state:RuntimeMaintenanceState,services:RuntimeMaintenanceServices):Promise<RuntimeMaintenanceState>{
  if(state.phase==='applied'){
    const observation=await observeAppliedRuntimeMaintenance(state,services);
    if(!observation.verified)throw new Error(observation.detail);
    return state;
  }
  try {
    let snapshot=await services.snapshot();
    if(state.original&&services.alive(state.original)){
      if(snapshot&&(!sameRuntime(snapshot.identity,state.original)||!snapshot.supported))
        throw new Error('The retained App Server generation no longer proves its exact supported listener identity.');
      if(state.phase==='waiting'&&!await services.nativeIdle())return state;
      state.phase='draining'; services.persist();
      services.signal(state.original);
      state.detail='Native graceful-only drain is active; accepted work is never force-stopped.';
      services.persist(); return state;
    }
    if(snapshot){
      if(state.original&&sameRuntime(snapshot.identity,state.original))throw new Error('The old App Server still answers but its process identity is uncertain.');
      if(!snapshot.masked){
        if(state.original)throw new Error('Another unmasked daemon replaced the retained generation; no unrelated process was signalled.');
        if(!snapshot.supported)throw new Error('The exact loaded App Server does not support the verified graceful-only signal.');
        if(!await services.nativeIdle())return state;
        state.original=snapshot.identity;state.phase='draining';services.persist();
        services.signal(state.original);state.detail='Native graceful-only drain requested.';services.persist();return state;
      }
    }else{
      state.phase='starting';services.persist();await services.start();snapshot=await services.snapshot();
    }
    if(!snapshot?.masked)throw new Error('The replacement App Server has not proved its ledger image mask.');
    await services.prove(snapshot.identity);
    state.replacement=snapshot.identity;state.phase='applied';state.detail='Masked replacement and provider API confirmed.';services.persist();
  }catch(error){
    if(state.phase==='applied')throw error;
    state.phase='uncertain';state.detail=error instanceof Error?error.message:String(error);services.persist();
  }
  return state;
}
