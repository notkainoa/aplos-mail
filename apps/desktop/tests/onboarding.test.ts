import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppState } from '../src/shared/types';
import { createService, type ServiceOptions } from '../src/main/service';
import { createStore } from '../src/main/store';
import { createEmpty } from '../src/engine/demo';
import { createGoogle } from '../src/main/google';
import { createGroq } from '../src/main/groq';

async function folder() {return mkdtemp(join(tmpdir(),'aplos-onboarding-'));}
async function open(dataDir:string,options:Partial<ServiceOptions>={}) {
  return createService({dataDir,google:await createGoogle({dataDir,clientId:''}),groq:createGroq({apiKey:''}),autoSyncMs:0,...options});
}
const get=async(service:Awaited<ReturnType<typeof open>>)=>await service.invoke('state.get') as AppState;

test('a fresh install starts with no accounts or mail, and stays empty after a restart',async()=>{
  const dataDir=await folder();
  try{
    let service=await open(dataDir);
    try{
      const state=await get(service);
      assert.deepEqual([state.accounts.length,state.threads.length,state.drafts.length,state.events.length],[0,0,0,0]);
      assert.equal(state.settings.onboardingDone,false);
      assert.equal(state.selectedAccountId,'all');
      // The empty shell still answers what the window asks for on load.
      assert.deepEqual((await service.invoke('state.get',{threadLimit:50}) as AppState).threads,[]);
      assert.deepEqual(await service.invoke('calendar.list',{}),[]);
      await service.invoke('sync');
      await service.invoke('settings.update',{patch:{theme:'dark'}});
    }finally{await service.close();}
    // Saved data is never replaced by the demo, even when the host asks for one.
    service=await open(dataDir,{demo:true});
    try{const state=await get(service);assert.equal(state.accounts.length,0);assert.equal(state.settings.theme,'dark');}
    finally{await service.close();}
  }finally{await rm(dataDir,{recursive:true,force:true});}
});

test('the demo is loaded only when asked for, and survives restarts',async()=>{
  const dataDir=await folder();
  try{
    let service=await open(dataDir);
    try{
      await service.invoke('settings.update',{patch:{theme:'light'}});
      const loaded=await service.invoke('demo.reset') as AppState;
      assert.deepEqual(loaded.accounts.map(a=>[a.id,a.provider]),[['work','demo'],['personal','demo']]);
      assert.equal(loaded.threads.length,18);
      assert.equal(loaded.settings.theme,'light','loading the demo keeps settings');
    }finally{await service.close();}
    service=await open(dataDir);
    try{assert.equal((await get(service)).accounts.length,2);}finally{await service.close();}
  }finally{await rm(dataDir,{recursive:true,force:true});}
});

test('a development host can start a fresh folder with the demo',async()=>{
  const dataDir=await folder();
  try{const service=await open(dataDir,{demo:true});try{const state=await get(service);assert.equal(state.accounts.length,2);assert.equal(state.threads.length,18);}finally{await service.close();}}
  finally{await rm(dataDir,{recursive:true,force:true});}
});

test('loading demo mail next to a real account keeps the account, its mail, Ask history and blocked senders',async()=>{
  const dataDir=await folder();
  try{
    const saved:AppState={...createEmpty(),
      accounts:[{id:'imap:me@example.org',name:'Me',email:'me@example.org',color:'#777',provider:'imap',connected:true}],
      threads:[{id:'imap:1',accountId:'imap:me@example.org',subject:'Real thread',summary:'',date:'2026-10-20T10:00:00.000Z',unread:true,status:'new',importance:'important',bookmarked:false,replyStatus:'none',
        messages:[{id:'m1',from:'friend@example.org',fromName:'Friend',to:['me@example.org'],date:'2026-10-20T10:00:00.000Z',text:'Hello',html:'<p>Hello</p>',attachments:[]}]}],
      conversations:[{id:'c1',title:'Earlier question',messages:[],updatedAt:'2026-10-20T10:00:00.000Z'}],blockedSenders:['nope@example.org']};
    saved.settings.onboardingDone=true;
    const store=createStore(dataDir);store.write(saved);store.close();
    const service=await open(dataDir);
    try{
      assert.equal((await get(service)).accounts.length,1,'existing data is kept as it is');
      const state=await service.invoke('demo.reset') as AppState;
      assert.deepEqual(state.accounts.map(a=>a.id).sort(),['imap:me@example.org','personal','work']);
      assert.ok(state.threads.some(t=>t.id==='imap:1'));
      assert.deepEqual(state.conversations.map(c=>c.id),['c1']);
      assert.deepEqual(state.blockedSenders,['nope@example.org']);
      assert.equal(state.settings.onboardingDone,true);
    }finally{await service.close();}
  }finally{await rm(dataDir,{recursive:true,force:true});}
});
