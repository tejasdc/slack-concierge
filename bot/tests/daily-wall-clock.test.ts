import {test,expect} from 'bun:test';
import {localParts} from '../src/quiet-hours';
import {nextDailyWallClock,localDayGap} from '../src/daily-wall-clock';

const daily={time:'06:00',timeZone:'America/New_York'};
const local=(instant:number)=>localParts(instant,{time_zone:daily.timeZone});

test('the 06:00 New York repeat advances across both daylight-saving changes',()=>{
  const march=Date.parse('2027-03-13T11:00:00Z');
  const marchNext=nextDailyWallClock(march,daily);
  expect(new Date(marchNext).toISOString()).toBe('2027-03-14T10:00:00.000Z');
  expect(local(marchNext).hour).toBe(6);
  expect(localDayGap(march,marchNext,daily.timeZone)).toBe(1);

  const november=Date.parse('2027-11-06T10:00:00Z');
  const novemberNext=nextDailyWallClock(november,daily);
  expect(new Date(novemberNext).toISOString()).toBe('2027-11-07T11:00:00.000Z');
  expect(local(novemberNext).hour).toBe(6);
  expect(localDayGap(november,novemberNext,daily.timeZone)).toBe(1);
});

test('a delayed wake skips missed local dates without a catch-up burst',()=>{
  const late=Date.parse('2027-03-17T12:00:00Z');
  expect(new Date(nextDailyWallClock(late,daily)).toISOString()).toBe('2027-03-18T10:00:00.000Z');
});

test('ambiguous and missing local hours each have one deterministic firing',()=>{
  const zone='America/New_York';
  expect(new Date(nextDailyWallClock(Date.parse('2027-11-07T00:00:00Z'),{time:'01:30',timeZone:zone})).toISOString())
    .toBe('2027-11-07T05:30:00.000Z');
  expect(new Date(nextDailyWallClock(Date.parse('2027-11-07T05:45:00Z'),{time:'01:30',timeZone:zone})).toISOString())
    .toBe('2027-11-08T06:30:00.000Z');
  expect(new Date(nextDailyWallClock(Date.parse('2027-03-14T00:00:00Z'),{time:'02:30',timeZone:zone})).toISOString())
    .toBe('2027-03-14T07:00:00.000Z');
});
