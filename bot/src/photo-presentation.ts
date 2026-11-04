import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

const photoKind=(name:string,contentType:string) => {
  const type=contentType.toLowerCase().split(';',1)[0];
  if(['image/heic','image/heif','image/heic-sequence','image/heif-sequence'].includes(type)||/\.(heic|heif)$/i.test(name))return 'heic';
  if(['image/dng','image/x-adobe-dng','image/x-dng'].includes(type)||/\.dng$/i.test(name))return 'dng';
  return null;
};

// Originals stay in session_attachments.bytes. This derivative is the image that browsers and
// agent tools can open; a Live Photo's separate movie remains its own attachment.
export function preparePhotoPresentation(name:string,contentType:string,bytes:Uint8Array):{name:string;contentType:'image/jpeg';bytes:Buffer}|null {
  const kind=photoKind(name,contentType);
  if(!kind)return null;
  const directory=mkdtempSync(join(tmpdir(),'concierge-photo-'));
  try {
    const source=join(directory,kind==='heic'?'original.heic':'original.dng');
    const destination=join(directory,'readable.jpg');
    writeFileSync(source,bytes,{mode:0o600});
    if(process.platform==='darwin') {
      const result=spawnSync('sips',['-s','format','jpeg','-s','formatOptions','90',source,'--out',destination],{timeout:30_000,stdio:'ignore'});
      if(result.status!==0)throw new Error('PHOTO_CONVERSION_UNAVAILABLE');
    } else if(kind==='heic') {
      const result=spawnSync('heif-convert',['-q','90',source,destination],{timeout:30_000,stdio:'ignore'});
      if(result.status!==0)throw new Error('PHOTO_CONVERSION_UNAVAILABLE');
    } else {
      const extracted=spawnSync('dcraw',['-e','-c',source],{timeout:30_000,maxBuffer:100_000_000});
      if(extracted.status!==0||!extracted.stdout.length)throw new Error('PHOTO_CONVERSION_UNAVAILABLE');
      const converted=spawnSync('convert',['-','-quality','90',destination],{input:extracted.stdout,timeout:30_000,stdio:['pipe','ignore','ignore']});
      if(converted.status!==0)throw new Error('PHOTO_CONVERSION_UNAVAILABLE');
    }
    const rendered=readFileSync(destination);
    if(rendered.length<4||rendered[0]!==0xff||rendered[1]!==0xd8)throw new Error('PHOTO_CONVERSION_INVALID');
    return {name:name.replace(/\.[^.]+$/,'')+'.jpg',contentType:'image/jpeg',bytes:rendered};
  } finally {rmSync(directory,{recursive:true,force:true});}
}
