import {expect,test} from 'bun:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {prepareProviderInput} from '../src/provider-input';

test('prepared collaboration guidance retains exact correlation and contains no automatic conversation cap',async()=>{
  const attachmentRoot=await mkdtemp(join(tmpdir(),'communication-guidance-'));
  try {
    const input=await prepareProviderInput({prompt:'Coordinate the contract',text:'Coordinate the contract',files:[],botToken:'unused',channel:'CFIXTURE',messageTs:'1789450000.123456',threadTs:'1789440000.123456',user:'UFIXTURE',client:{},hydrateSlackLinks:false,attachmentRoot});
    expect(input.replayText).toContain('mandatory return obligation');
    expect(input.replayText).toContain('answer each by its own request ID');
    expect(input.replayText).not.toMatch(/stop after|eight.inter.session.hops|eight.hop|hop limit/i);
    expect(input.prompt).toContain('Preserve Stop/archive decisions and exact work ownership.');
  } finally {await rm(attachmentRoot,{recursive:true,force:true});}
});
