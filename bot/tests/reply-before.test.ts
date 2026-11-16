import {describe,expect,test} from 'bun:test';
import {replyOwnWords,withBefore} from '../src/reply-before';

describe('What came before note', () => {
  test('the agent\'s own words lead and the note closes the reply', () => {
    const text=withBefore('Earlier session fixed headings.','TL;DR: Done.\n\nDetail.');
    expect(text.startsWith('TL;DR: Done.')).toBe(true);
    expect(text.endsWith('What came before: Earlier session fixed headings.')).toBe(true);
  });

  test('own words come back without the note, for new and earlier recorded replies', () => {
    const before='Earlier work.';
    expect(replyOwnWords({before,replyBody:withBefore(before,'{"group":"x"}')})).toBe('{"group":"x"}');
    expect(replyOwnWords({before,replyBody:`What came before: ${before}\n\n{"group":"x"}`})).toBe('{"group":"x"}');
    expect(replyOwnWords({before,replyBody:withBefore(before,'')})).toBe('');
  });
});
