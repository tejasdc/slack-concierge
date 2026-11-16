import {localParts} from './quiet-hours';

export type DailyWallClock={time:string;timeZone:string};

export function validDailyWallClock(value:DailyWallClock):boolean {
  if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(value.time))return false;
  if(!/^(UTC|[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)+)$/.test(value.timeZone))return false;
  try {new Intl.DateTimeFormat('en-US',{timeZone:value.timeZone});return true;}
  catch {return false;}
}

/** One firing per local calendar date. A repeated hour uses its first occurrence; a missing
 * hour uses the first valid minute after the requested wall time on that date. */
export function nextDailyWallClock(after:number,value:DailyWallClock):number {
  if(!validDailyWallClock(value))throw new Error('Name a valid HH:MM time and IANA time zone.');
  const [hour,minute]=value.time.split(':').map(Number);
  const zone={time_zone:value.timeZone};
  const local=localParts(after,zone);
  for(let day=0;day<4;day++) {
    const date=new Date(Date.UTC(local.year,local.month-1,local.day+day));
    const year=date.getUTCFullYear(),month=date.getUTCMonth()+1,dayOfMonth=date.getUTCDate();
    const wall=Date.UTC(year,month-1,dayOfMonth,hour,minute);
    const candidates=new Set<number>();
    for(let step=-6;step<=6;step++) {
      const probe=wall+step*6*60*60_000;
      const p=localParts(probe,zone);
      const offset=Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute,p.second)-probe;
      const instant=wall-offset;
      const actual=localParts(instant,zone);
      if(actual.year===year&&actual.month===month&&actual.day===dayOfMonth&&actual.hour===hour&&actual.minute===minute)
        candidates.add(instant);
    }
    let first=candidates.size?Math.min(...candidates):null;
    if(first===null) {
      // Only a daylight-saving gap needs this bounded minute walk.
      for(let instant=wall-14*60*60_000;instant<=wall+12*60*60_000;instant+=60_000) {
        const p=localParts(instant,zone);
        if(p.year===year&&p.month===month&&p.day===dayOfMonth&&p.hour*60+p.minute>=hour*60+minute) {
          first=instant;break;
        }
      }
    }
    if(first!==null&&first>after)return first;
  }
  throw new Error('Could not resolve the next daily local time.');
}

export function localDayGap(from:number,to:number,timeZone:string):number {
  const zone={time_zone:timeZone},a=localParts(from,zone),b=localParts(to,zone);
  return Math.round((Date.UTC(b.year,b.month-1,b.day)-Date.UTC(a.year,a.month-1,a.day))/86_400_000);
}
