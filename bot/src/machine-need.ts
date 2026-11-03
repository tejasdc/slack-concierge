export type MachineNeedKind = 'ios-native' | 'mac-app' | 'mac-file' | 'mac-screen' | 'messages' | 'human-mac' | 'browser-fallback' | 'provider-renewal';
export type ServerBrowserAttempt = {url:string;failure:string};
export type MachineNeed = {kind:MachineNeedKind;why:string;serverAttempt?:ServerBrowserAttempt};

const KINDS = new Set<MachineNeedKind>(['ios-native','mac-app','mac-file','mac-screen','messages','human-mac','browser-fallback']);

/** The receiving machine gets a named capability and the specific observation it requires. */
export function parseMachineNeed(value:unknown,serverAttempt?:unknown):MachineNeed {
  if(typeof value!=='string')throw new Error('Mac work needs --machine-need kind:specific reason.');
  const at=value.indexOf(':');
  const kind=value.slice(0,at) as MachineNeedKind;
  const why=value.slice(at+1).trim();
  if(at<1||!KINDS.has(kind)||why.length<12||why.length>300||/[\r\n]/.test(why))
    throw new Error('Mac work needs --machine-need ios-native|mac-app|mac-file|mac-screen|messages|human-mac|browser-fallback:specific reason. Ordinary browser and phone-size checks run on the server.');
  if(kind!=='browser-fallback'){
    if(serverAttempt!==undefined)throw new Error('A server browser attempt belongs only to browser-fallback work.');
    return {kind,why};
  }
  if(!serverAttempt||typeof serverAttempt!=='object')throw new Error('A Mac browser fallback needs the failed server URL and observed failure.');
  const attempt=serverAttempt as Record<string,unknown>;
  if(typeof attempt.url!=='string'||typeof attempt.failure!=='string'||attempt.failure.trim().length<20
      ||attempt.failure.length>1000||/[\r\n]/.test(attempt.failure))
    throw new Error('A Mac browser fallback needs the failed server URL and a specific observed failure.');
  let url:URL;
  try {url=new URL(attempt.url);} catch {throw new Error('The failed server URL must be an HTTP or HTTPS website.');}
  if(!['http:','https:'].includes(url.protocol)||!url.hostname||url.username||url.password||attempt.url.length>2048)
    throw new Error('The failed server URL must be an HTTP or HTTPS website without credentials.');
  return {kind,why,serverAttempt:{url:url.origin,failure:attempt.failure.trim()}};
}
