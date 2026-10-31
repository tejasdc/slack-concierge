/**
 * His night, as one setting: the saved-work quiet hours (Settings → Saved work) in his time zone.
 * Banked work spends them because he is asleep; reminders hold through them for the same reason.
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
