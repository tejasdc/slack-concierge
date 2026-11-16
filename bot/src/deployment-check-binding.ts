import {createHash} from 'node:crypto';
import {execFileSync,spawnSync} from 'node:child_process';
import {existsSync,fstatSync,lstatSync,openSync,closeSync,readFileSync,readlinkSync,readdirSync,realpathSync,statSync,mkdtempSync,rmSync,mkdirSync} from 'node:fs';
import {basename,dirname,join,relative,resolve} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {processIdentity,type ProcessIdentity} from './runtime-identity';
import {verifiedAuthorityArtifact,deploymentReleaseRoot} from './deployment-launch-authority';

export type CheckActor={identity:ProcessIdentity;parent:number;argv:string[];cwd:string;entry:string|null;args:string[]};
type FileImage={path:string;device:number;inode:number;sha256:string};
type ControllerImage={kind:'sealed'|'source';manager:string;script:FileImage;artifact?:string;artifactDigest?:string;
  sourceRoot?:string;sourceCommit?:string|null;files?:FileImage[]};
export type CheckEnrollment={format:1;deploy:ProcessIdentity;preflight:ProcessIdentity;releaseRoot:string;
  repository:string;root:string;controller:ControllerImage};
export type CheckBinding={enrollment:CheckEnrollment;entrance:CheckActor;manager:CheckActor;run:string;commit:string;
  controller:ControllerImage;
  source:string;stage:string;dependency:{path:string;device:number;inode:number};environment:NodeJS.ProcessEnv;
  archiveSha256:string;runtime:{device:string;inode:string;sha256:string};runtimeFd:number};

const sha=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');
const sameBirth=(a:ProcessIdentity,b:ProcessIdentity)=>isDeepStrictEqual(a,b);
export function checkActor(pid:number):CheckActor{
 const identity=processIdentity(pid);
 const raw=readFileSync(`/proc/${pid}/stat`,'utf8');
 const fields=raw.slice(raw.lastIndexOf(')')+2).trim().split(/\s+/);
 const argv=readFileSync(`/proc/${pid}/cmdline`,'utf8').split('\0').filter(Boolean);
 const cwd=realpathSync(`/proc/${pid}/cwd`);
 const index=argv[1]==='run'?2:1;
 const value=argv[index];
 const entry=value&&!value.startsWith('-')?resolve(cwd,value):null;
 if(!sameBirth(identity,processIdentity(pid)))throw Error('Release check participant changed during inspection.');
 return{identity,parent:Number(fields[1]),argv,cwd,entry,args:argv.slice(index+1)};
}
export function checkAncestry(pid:number):CheckActor[]{
 const actors:CheckActor[]=[],seen=new Set<number>();
 while(pid>1){
  if(seen.has(pid))throw Error('Release check ancestry is cyclic.');seen.add(pid);
  const actor=checkActor(pid);actors.push(actor);pid=actor.parent;
 }
 return actors;
}
function environment(pid:number):NodeJS.ProcessEnv{
 return Object.fromEntries(readFileSync(`/proc/${pid}/environ`,'utf8').split('\0').filter(Boolean).map(item=>{
  const at=item.indexOf('=');return[item.slice(0,at),item.slice(at+1)];
 }));
}
function fileContents(path:string):{image:FileImage;bytes:Buffer}{
 const fd=openSync(path,'r');
 try{
  const before=fstatSync(fd),bytes=readFileSync(fd),after=fstatSync(fd);
  if(!before.isFile()||before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size
    ||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)
   throw Error('Release check source changed during inspection.');
  return{image:{path,device:before.dev,inode:before.ino,sha256:sha(bytes)},bytes};
 }finally{closeSync(fd);}
}
const fileImage=(path:string)=>fileContents(path).image;
function deployActor(actor:CheckActor){
 if(!['bash','sh'].includes(basename(actor.argv[0]??''))||!actor.entry||basename(actor.entry)!=='deploy.sh')return false;
 return existsSync(`/proc/${actor.identity.pid}/fd/255`);
}
export function fixedCheckResourceRoot(releaseRoot:string,deploy:ProcessIdentity){
 return join(releaseRoot,'staging',`native-check-${deploy.bootId}-${deploy.pid}-${deploy.startTicks}`);
}
/** A locator only. Authority is established independently by the native peer and enrollment. */
export function locateFixedCheckResource(pid=process.pid):string|null{
 const chain=checkAncestry(pid);
 const entrance=chain.find(actor=>actor.entry?.endsWith('/source/bot/scripts/presentation-release-check.ts'));
 if(!entrance?.entry)return null;
 const source=resolve(dirname(entrance.entry),'../..'),stage=dirname(source);
 if(basename(dirname(stage))!=='staging')return null;
 const root=dirname(dirname(stage));
 for(const actor of chain.filter(deployActor)){
  const candidate=fixedCheckResourceRoot(root,actor.identity);
  if(existsSync(candidate))return candidate;
 }
 return null;
}
export function locateFixedCheckEnrollment(pid=process.pid):{deploy:CheckActor;root:string;repository:string;releaseRoot:string}|null{
 const chain=checkAncestry(pid),preflight=chain.find(actor=>actor.entry?.endsWith('/bot/scripts/migrate-deployment-repair.ts')
  &&actor.args.includes('--backup-if-needed'));
 if(!preflight?.entry)return null;
 const deploy=chain.slice(chain.indexOf(preflight)+1).find(deployActor);
 if(!deploy)return null;
 const env=environment(deploy.identity.pid),releaseRoot=resolve(env.CONCIERGE_DEPLOYMENT_RELEASE_ROOT??deploymentReleaseRoot());
 return{deploy,root:fixedCheckResourceRoot(releaseRoot,deploy.identity),repository:resolve(dirname(preflight.entry),'../..'),releaseRoot};
}
function sourceGraph(entry:string):FileImage[]{
 const visited=new Map<string,FileImage>();
 const inspect=(path:string)=>{
  path=realpathSync(path);if(visited.has(path))return;
  const captured=fileContents(path);visited.set(path,captured.image);
  if(!/\.[cm]?[jt]sx?$/.test(path))return;
  const code=captured.bytes.toString('utf8');
  const imports=new Bun.Transpiler({loader:path.endsWith('tsx')?'tsx':path.endsWith('.ts')?'ts':'js'}).scan(code).imports;
  for(const item of imports){
   if(!item.path.startsWith('.'))continue;
   const base=resolve(dirname(path),item.path),selected=[base,base+'.ts',base+'.js',base+'.mjs',base+'.json',join(base,'index.ts'),join(base,'index.js')]
    .find(candidate=>existsSync(candidate)&&statSync(candidate).isFile());
   if(!selected)throw Error('Selected source controller has an unresolved relative import.');
   inspect(selected);
  }
 };
 inspect(entry);return[...visited.values()].sort((a,b)=>a.path.localeCompare(b.path));
}
async function controllerImage(deploy:CheckActor):Promise<ControllerImage>{
 const descriptor=`/proc/${deploy.identity.pid}/fd/255`,script=fileImage(descriptor);
 const loaded=readlinkSync(descriptor).replace(/ \(deleted\)$/,'');
 if(basename(loaded)!=='deploy.sh')throw Error('Selected deployment script is not the normal release entry.');
 const control=dirname(loaded),manager=join(control,existsSync(join(control,'release-manager.js'))?'release-manager.js':'release-manager.ts');
 if(!existsSync(manager))throw Error('Selected deployment has no release manager.');
 if(basename(control)==='control'&&existsSync(join(dirname(control),'manifest.json'))){
  const artifact=await verifiedAuthorityArtifact(dirname(control));
  const manifest=JSON.parse(readFileSync(join(artifact,'manifest.json'),'utf8'));
  if(sha(readFileSync(join(control,'deploy.sh')))!==script.sha256)throw Error('Loaded deployment script differs from its selected control release.');
  return{kind:'sealed',manager,script,artifact,artifactDigest:manifest.artifact_digest};
 }
 const sourceRoot=resolve(control,'../..');let sourceCommit:string|null=null;
 try{sourceCommit=execFileSync('/usr/bin/git',['-C',sourceRoot,'rev-parse','HEAD'],{encoding:'utf8'}).trim();}catch{}
 // Source operators remain supported. These are captured before detach and
 // rechecked under the caller's source custody; they are not a clean-tree wall
 // or a claim that a later pathname read recovers an already loaded JS image.
 return{kind:'source',manager,script,sourceRoot,sourceCommit,files:sourceGraph(manager)};
}
export async function enrollFixedCheck(authorityPid:number):Promise<CheckEnrollment>{
 const located=locateFixedCheckEnrollment(authorityPid);
 if(!located)throw Error('Native check enrollment is not inside normal deployment preflight.');
 const chain=checkAncestry(authorityPid),preflight=chain.find(actor=>actor.entry?.endsWith('/bot/scripts/migrate-deployment-repair.ts')&&actor.args.includes('--backup-if-needed'))!;
 const controller=await controllerImage(located.deploy);
 if(!sameBirth(located.deploy.identity,processIdentity(located.deploy.identity.pid))
  ||!sameBirth(preflight.identity,processIdentity(preflight.identity.pid)))throw Error('Deployment preflight changed during enrollment.');
 return{format:1,deploy:located.deploy.identity,preflight:preflight.identity,releaseRoot:located.releaseRoot,
  repository:located.repository,root:located.root,controller};
}
function option(actor:CheckActor,name:string){
 const index=actor.args.indexOf(name);if(index<0||!actor.args[index+1])throw Error('Release check manager is missing its selected source identity.');
 return actor.args[index+1]!;
}
function controllerWitness(image:ControllerImage){
 const{sourceCommit,...witness}=image;return witness;
}
function sameControllerSelection(enrolled:ControllerImage,current:ControllerImage){
 if(enrolled.kind!==current.kind)return false;
 if(enrolled.kind==='sealed')return isDeepStrictEqual(enrolled,current);
 // A source manager is selected later, not frozen when preflight enrolls A.
 // Capture its module bytes at this call and recheck those after the check;
 // unrelated HEAD/dirty-worktree state is not an admission policy.
 return enrolled.manager===current.manager&&enrolled.sourceRoot===current.sourceRoot
  &&isDeepStrictEqual(enrolled.script,current.script);
}
function validateArchive(source:string,repository:string,commit:string,resourceRoot:string):string{
 // Git and tar interpret the same archive as the selected manager. Compare a
 // separate owned extraction, including modes and links, then retire it below.
 const scratch=mkdtempSync(join(resourceRoot,'archive-')),expected=join(scratch,'source'),archive=join(scratch,'source.tar');
 try{
  mkdirSync(expected);
  const output=openSync(archive,'wx',0o600);
  try{
   const result=spawnSync('/usr/bin/git',['-C',repository,'archive','--format=tar',commit],{stdio:['ignore',output,'pipe']});
   if(result.error)throw result.error;
   if(result.status!==0)throw Error('Cannot read the manager-selected source archive.');
  }finally{closeSync(output);}
  execFileSync('/usr/bin/tar',['-xf',archive,'-C',expected]);
  const compare=(at:string)=>{
   const left=join(expected,at),right=join(source,at);
   const wanted=readdirSync(left).sort(),actual=readdirSync(right).filter(name=>!(at==='bot'&&name==='node_modules')).sort();
   if(!isDeepStrictEqual(wanted,actual))throw Error('Staged release has extra or missing source entries.');
   for(const name of wanted){
    const a=join(left,name),b=join(right,name),one=lstatSync(a),two=lstatSync(b);
    if((one.mode&0o177777)!==(two.mode&0o177777))throw Error('Staged source type or mode changed.');
    if(one.isDirectory())compare(join(at,name));
    else if(one.isSymbolicLink()){
     if(readlinkSync(a)!==readlinkSync(b))throw Error('Staged source link changed.');
    }else if(one.isFile()){
     if(!readFileSync(a).equals(readFileSync(b)))throw Error('Staged source bytes differ from the selected archive.');
    }else throw Error('Selected source contains an unsupported entry type.');
   }
  };
  compare('');return sha(readFileSync(archive));
 }finally{rmSync(scratch,{recursive:true,force:true});}
}
export async function bindFixedCheck(peerPid:number,enrollment:CheckEnrollment):Promise<CheckBinding>{
 if(enrollment.format!==1)throw Error('Unknown native check enrollment.');
 const chain=checkAncestry(peerPid),d=chain.find(actor=>sameBirth(actor.identity,enrollment.deploy));
 if(!d)throw Error('Presentation caller is outside its enrolled deployment.');
 const entrance=chain.find(actor=>actor.entry?.endsWith('/source/bot/scripts/presentation-release-check.ts'));
 const managers=chain.filter(actor=>actor.args[0]==='prepare'&&actor.entry&&realpathSync(actor.entry)===realpathSync(enrollment.controller.manager));
 if(!entrance?.entry||managers.length!==1)throw Error('Presentation caller has no exact selected release manager.');
 const manager=managers[0]!,control=await controllerImage(d);
 if(!sameControllerSelection(enrollment.controller,control))throw Error('Deployment selected another controller after native enrollment.');
 const run=option(manager,'--run-id'),commit=option(manager,'--commit').toLowerCase();
 if(!/^[0-9a-z-]{8,100}$/.test(run)||!/[0-9a-f]{40}/.test(commit)||commit.length!==40)throw Error('Invalid selected release source identity.');
 const source=resolve(dirname(entrance.entry),'../..'),stage=dirname(source),stageName=basename(stage);
 if(dirname(stage)!==join(enrollment.releaseRoot,'staging')||!stageName.startsWith(run+'-')
  ||!/^[-0-9a-f]{36}$/.test(stageName.slice(run.length+1)))throw Error('Presentation source is outside its selected manager stage.');
 const managerEnvironment=environment(manager.identity.pid);
 const repository=realpathSync(resolve(manager.cwd,managerEnvironment.CONCIERGE_REPO??'/var/lib/slack-concierge-deployment/source'));
 if(repository!==realpathSync(enrollment.repository))throw Error('Release manager selected another deployment source repository.');
 const archiveSha256=validateArchive(source,enrollment.repository,commit,enrollment.root);
 const dependencyPath=realpathSync(join(enrollment.repository,'bot/node_modules')),dependencyLink=join(source,'bot/node_modules');
 if(!lstatSync(dependencyLink).isSymbolicLink()||realpathSync(dependencyLink)!==dependencyPath)throw Error('Presentation dependency selection differs from the manager.');
 const dependency=statSync(dependencyPath);
 const runtimeFd=openSync(`/proc/${manager.identity.pid}/exe`,'r');
 try{
  const runtimeStat=fstatSync(runtimeFd,{bigint:true}),runtimeBytes=readFileSync(runtimeFd);
  if(!runtimeStat.isFile()||runtimeBytes[0]!==0x7f||runtimeBytes.subarray(1,4).toString()!=='ELF')throw Error('Selected manager has no retained ELF runtime.');
  if(!sameBirth(manager.identity,processIdentity(manager.identity.pid)))throw Error('Selected manager changed while retaining its runtime.');
  return{enrollment,entrance,manager,controller:control,run,commit,source,stage,dependency:{path:dependencyPath,device:dependency.dev,inode:dependency.ino},
   environment:environment(entrance.identity.pid),archiveSha256,runtimeFd,
   runtime:{device:String(runtimeStat.dev),inode:String(runtimeStat.ino),sha256:sha(runtimeBytes)}};
 }catch(error){closeSync(runtimeFd);throw error;}
}
function bindingWitness(binding:CheckBinding){
 return{entrance:binding.entrance.identity,manager:binding.manager.identity,controller:controllerWitness(binding.controller),run:binding.run,commit:binding.commit,
  // Each observation compares every staged byte/mode/link to this same Git
  // object. Tar header timestamps are evidence, not an extra source authority.
  source:binding.source,stage:binding.stage,dependency:binding.dependency,
  runtime:{device:binding.runtime.device,inode:binding.runtime.inode,sha256:binding.runtime.sha256}};
}
export async function recheckFixedCheck(binding:CheckBinding){
 const after=await bindFixedCheck(binding.entrance.identity.pid,binding.enrollment);
 try{
  if(!isDeepStrictEqual(bindingWitness(binding),bindingWitness(after)))throw Error('Release check source or runtime changed during execution.');
 }finally{closeSync(after.runtimeFd);}
}
export function fixedCheckEnvironment(binding:CheckBinding):NodeJS.ProcessEnv{
 const state=join(binding.stage,'isolated-owner'),capture=join(binding.stage,'isolated-capture');
 mkdirSync(state,{recursive:true,mode:0o700});mkdirSync(capture,{recursive:true,mode:0o700});
 const env:NodeJS.ProcessEnv={...binding.environment,CONCIERGE_STATE_DIR:state,CONCIERGE_STATE_DB:join(state,'state.db'),
  CONCIERGE_CAPTURE_STATE_DIR:capture,CONCIERGE_PRIVATE_CODE_STATE:state,CONCIERGE_TEST_MODE:'1'};
 for(const name of Object.keys(env))if(name.startsWith('FIXED_PRESENTATION_')||name.startsWith('CONCIERGE_PRIVATE_CODE_')
  ||name==='CONCIERGE_PRIVATE_DATABASE_MASKS'||name==='CONCIERGE_RELEASE_LIFETIME_FD'||name==='CONCIERGE_RELEASE_LIFETIME_GENERATION')delete env[name];
 env.CONCIERGE_PRIVATE_CODE_STATE=state;
 // The trusted outer resource owns this command's native group. Private PID
 // isolation contains older fixtures that predate shared-group cooperation.
 env.CONCIERGE_FIXTURE_SHARED_GROUP='1';
 return env;
}
