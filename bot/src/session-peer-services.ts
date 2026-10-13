import {SessionCommunicationCoordinator} from './session-communication';
import {PeerClient,SessionPeers,type PeerSettings} from './session-peers';
import {ProjectSetup} from './project-setup';
import {PeerLinks} from './peer-links';
import type {SessionOwner} from './session-owner';

/** The native session's peer entrance is composed once for every machine and runtime. */
export function createSessionPeerServices(input:{
  settings:PeerSettings;
  workspaceRoot:string;
  owner:()=>SessionOwner;
  isOwnerAlive:(ownerId:string)=>boolean;
  onError:(error:unknown)=>void;
  onPeerError?:(error:unknown)=>void;
}) {
  const {settings,workspaceRoot,owner,isOwnerAlive,onError,onPeerError}=input;
  const clients=new Map(settings.peers.map(peer=>[peer.name,
    new PeerClient(peer.name,peer.url,settings.token!,peer.paths,peer.archives)] as const));
  const projectSetup=new ProjectSetup(workspaceRoot,settings.self??'local',clients,owner,()=>peers?.wake());
  const peerLinks=new PeerLinks(settings.self??'local',clients,owner);
  const peers=settings.self?new SessionPeers({self:settings.self,clients,
    get owner(){return owner();},isOwnerAlive,onError:onPeerError??onError,
    onWake:()=>{projectSetup.wake();peerLinks.wake();},
    hasPendingOperations:()=>projectSetup.hasPending()||peerLinks.hasPending()}):undefined;
  const communication=new SessionCommunicationCoordinator({
    get owner(){return owner();},isOwnerAlive,onError,...(peers?{peers}:{})});
  const bindOwner=()=>{
    const session=owner();
    session.projectSetup=projectSetup;
    session.peerLinks=peerLinks;
    session.communication=communication;
  };
  return {projectSetup,peerLinks,peers,communication,bindOwner};
}
