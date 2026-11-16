import {mock} from "bun:test";
import {existsSync,readFileSync} from "node:fs";
import {join} from "node:path";

mock.module("../src/deployment-launch-authority",()=>({deploymentLedgerMode:async()=>"owner"}));
mock.module("bun:sqlite",()=>({Database:class {constructor(){throw new Error("CANONICAL_SQLITE_CONSTRUCTOR_FORBIDDEN");}}}));
mock.module("../src/deployment-worker-wake",()=>({notifyDeploymentWorker:async()=>true}));
mock.module("../src/deployment-release",()=>({
 defaultReleaseEnvironment:()=>({}),
 TrustedRootReleaseManager:class {async restore(path:string){
  if(path!==join(process.env.CONCIERGE_STATE_DIR!,"sealed-lkg"))throw new Error("Unexpected fixture restore path.");
  const marker=join(process.env.CONCIERGE_STATE_DIR!,"restore.count");
  await Bun.write(marker,String(Number(existsSync(marker)?readFileSync(marker,"utf8"):"0")+1));
  return {git_commit:"cccccccccccccccccccccccccccccccccccccccc"};
 }}
}));
