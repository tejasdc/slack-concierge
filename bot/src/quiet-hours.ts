/**
 * His night, as one setting: the saved-work quiet hours (Settings → Saved work) in his time zone.
 * Banked work spends them because he is asleep.
 */
export type QuietHours={quiet_start_hour:number;quiet_end_hour:number;time_zone:string};

export function localParts(ms:number,settings:{time_zone:string}) {
  const clock=new Intl.DateTimeFormat('en-US',{timeZone:settings.time_zone,year:'numeric',month:'numeric',day:'numeric',hour:'numeric',hourCycle:'h23',minute:'numeric',second:'numeric'});
  const parts=Object.fromEntries(clock.formatToParts(new Date(ms)).filter(part=>part.type!=='literal').map(part=>[part.type,Number(part.value)]));
  return {year:parts.year!,month:parts.month!,day:parts.day!,hour:parts.hour!,minute:parts.minute!,second:parts.second!};
}

export function inQuietHours(now:number,settings:QuietHours):boolean {
  const hour=localParts(now,settings).hour;
  return settings.quiet_start_hour<settings.quiet_end_hour
    ?hour>=settings.quiet_start_hour&&hour<settings.quiet_end_hour
    :hour>=settings.quiet_start_hour||hour<settings.quiet_end_hour;
}

function localOffset(ms:number,settings:QuietHours) {
  const p=localParts(ms,settings);
  return Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute,p.second)-Math.floor(ms/1000)*1000;
}

export const QUIET_STOP_MARGIN_MS=5*60_000;
export function nextQuietEnd(now:number,settings:QuietHours):number {
  const p=localParts(now,settings);
  for(let day=0;day<3;day++) {
    const wall=Date.UTC(p.year,p.month-1,p.day+day,settings.quiet_end_hour);
    let candidate=wall-localOffset(wall,settings);
    candidate=wall-localOffset(candidate,settings);
    if(candidate>now&&inQuietHours(candidate-1000,settings))return candidate;
  }
  return now+24*60*60_000;
}

export function quietOnlyAdmits(now:number,settings:QuietHours):boolean {
  return inQuietHours(now,settings)&&now<nextQuietEnd(now,settings)-QUIET_STOP_MARGIN_MS;
}
