export type MachineNeedKind = 'ios-native' | 'mac-app' | 'mac-file' | 'mac-screen' | 'messages' | 'human-mac';
export type MachineNeed = {kind:MachineNeedKind;why:string};

const KINDS = new Set<MachineNeedKind>(['ios-native','mac-app','mac-file','mac-screen','messages','human-mac']);

/** The receiving machine gets a named capability and the specific observation it requires. */
export function parseMachineNeed(value:unknown):MachineNeed {
  if(typeof value!=='string')throw new Error('Mac work needs --machine-need kind:specific reason.');
  const at=value.indexOf(':');
  const kind=value.slice(0,at) as MachineNeedKind;
  const why=value.slice(at+1).trim();
  if(at<1||!KINDS.has(kind)||why.length<12||why.length>300||/[\r\n]/.test(why))
    throw new Error('Mac work needs --machine-need ios-native|mac-app|mac-file|mac-screen|messages|human-mac:specific reason. Ordinary browser and phone-size checks run on the server.');
  return {kind,why};
}
