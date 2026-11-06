/**
 * A peer catalogue stores a summary, not the full view every session reader expects.
 * Present that summary with explicit unavailable controls until the exact owner answers.
 */
export function peerCatalogueView(card:any,peer:string,availability:unknown,lastSeenAtMs:number):any {
  const reason=`Search has only a summary of this session; open it on the ${peer} to see its controls.`;
  return {
    activeRunId:null,latestRunId:null,nativeKey:null,nativeBinding:null,standingRole:null,handoff:null,generation:0,projectPath:null,
    attention:{sessionId:card.id,actorId:'owner',readGeneration:0,dismissedGeneration:0,open:[]},withdrawnNeeds:[],backgroundWait:null,
    lineage:null,resurrection:null,resumeMachine:null,continuedAs:null,consultationSource:null,policyLabel:null,
    fidelity:{mode:'native',dialogue:'partial',branch:'unknown',compaction:'unknown',tools:'missing',attachments:'unknown',environment:'unavailable',omissions:[reason]},
    ...card,
    capabilities:{send:false,resume:false,stop:false,steer:false,fork:false,consult:false,recover:false,models:[],attachments:[],reason},
    peer,availability,lastSeenAt:Number.isFinite(lastSeenAtMs)?new Date(lastSeenAtMs).toISOString():null
  };
}
