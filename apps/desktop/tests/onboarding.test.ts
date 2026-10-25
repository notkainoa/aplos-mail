import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Account, AppState, SetupProgress, Thread } from '../src/shared/types';
import { ProviderError, type MailProvider, type SyncResult } from '../src/engine/provider';
import { SETUP_AI_LIMIT } from '../src/engine/service';
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

// A fake mail host whose first sync reports progress, so setup can be driven without a network.
const host:Account={id:'j1',name:'Alex',email:'alex@example.test',provider:'jmap',connected:true,color:'#aaa',calendarConnected:false};
const mail=(n:number):Thread=>({id:`j1:${n}`,remoteId:String(n),accountId:'j1',subject:`Thread ${n}`,summary:'',date:new Date(Date.UTC(2026,9,1,0,n)).toISOString(),unread:true,status:'new',importance:'important',bookmarked:false,replyStatus:'none',labels:['INBOX'],
  messages:[{id:`m${n}`,from:'sam@example.test',fromName:'Sam',to:[host.email],date:new Date(Date.UTC(2026,9,1,0,n)).toISOString(),text:`Synthetic message ${n}`,attachments:[]}]});
async function setupHarness({count=3,ai=true,fail=''}:{count?:number;ai?:boolean;fail?:string}={}) {
  const dataDir=await folder();
  const control={fail,hold:undefined as Promise<void>|undefined,progress:[] as number[]};
  const fake=():MailProvider=>({
    kind:'jmap',available:true,capabilities:()=>({labels:false,importance:false,aliases:false,signatures:false,calendar:false,serverSearch:false}),
    connect:async()=>host,disconnect:async()=>{},
    async sync(_a,cursor,context){
      await control.hold;
      if(control.fail)throw new ProviderError(control.fail,403,false);
      if(cursor)return {threads:[],flags:[],removed:[],reset:false,cursor};
      for(let i=0;i<=count;i+=Math.max(1,Math.floor(count/4))){context.progress?.(i,count);control.progress.push(i);}
      return {threads:Array.from({length:count},(_,i)=>mail(i)),flags:[],removed:[],reset:true,cursor:'c1'} as SyncResult;
    },
    search:async()=>[],updateThread:async()=>{},findSent:async()=>undefined,send:async()=>({}),attachment:async(_a,_t,x)=>x,close(){},
  });
  const summarized:string[]=[];const groq=createGroq({apiKey:''});
  const service=await open(dataDir,{providers:{jmap:fake},groq:ai?{...groq,available:true,summarize:async(t:Thread)=>{summarized.push(t.id);return {summary:`Summary of ${t.subject}`};}}:groq});
  return {service,control,summarized,async cleanup(){await service.close();await rm(dataDir,{recursive:true,force:true});}};
}
const settle=async(fn:()=>boolean)=>{for(let i=0;i<200&&!fn();i++)await new Promise(r=>setTimeout(r,10));assert.ok(fn(),'timed out');};

test('connecting from onboarding returns at once and leaves the AI pass to setup',async()=>{
  const h=await setupHarness();
  try{
    let release!:()=>void;h.control.hold=new Promise(r=>{release=r;});
    const connected=await h.service.invoke('account.connect',{provider:'jmap',setup:true}) as AppState;
    assert.deepEqual(connected.accounts.map(a=>a.id),['j1']);
    assert.equal(connected.settings.onboardingDone,false,'connecting no longer ends onboarding by itself');
    assert.equal(connected.threads.length,0,'it did not wait for the sync');
    release();
    let synced=0;await settle(()=>{void h.service.invoke('state.get').then(x=>{synced=(x as AppState).threads.length;});return synced===3;});
    assert.deepEqual(h.summarized,[],'the connect-time sync did not run AI');
    const events:SetupProgress[]=[];h.service.subscribe(e=>{if(e.type==='setup.progress')events.push(e.payload as SetupProgress);});
    const done=await h.service.invoke('setup.run') as SetupProgress;
    assert.equal(done.state,'done');
    assert.deepEqual(done.accounts.map(a=>[a.email,a.phase]),[['alex@example.test','done']]);
    assert.deepEqual(done.ai,{state:'done',done:3,total:3,background:0});
    assert.deepEqual(new Set(h.summarized),new Set(['j1:0','j1:1','j1:2']));
    assert.ok(events.some(e=>e.state==='syncing')&&events.some(e=>e.state==='summarizing')&&events.at(-1)!.state==='done');
  }finally{await h.cleanup();}
});

test('setup reports first-sync progress and caps the AI wait at the newest Home emails',async()=>{
  const count=SETUP_AI_LIMIT+12,h=await setupHarness({count});
  try{
    const seen:SetupProgress[]=[];h.service.subscribe(e=>{if(e.type==='setup.progress')seen.push(e.payload as SetupProgress);});
    await h.service.invoke('account.connect',{provider:'jmap',setup:true});
    const done=await h.service.invoke('setup.run') as SetupProgress;
    assert.equal(done.accounts[0].target,count);assert.equal(done.accounts[0].fetched,count);
    assert.ok(seen.some(p=>p.accounts[0]?.phase==='mail'&&p.accounts[0].target===count),'mail progress was reported');
    assert.deepEqual(done.ai,{state:'done',done:SETUP_AI_LIMIT,total:SETUP_AI_LIMIT,background:12});
    // The Home set is the newest mail; the oldest twelve are summarized after setup returns.
    const newest=Array.from({length:SETUP_AI_LIMIT},(_,i)=>`j1:${count-1-i}`);
    assert.deepEqual(new Set(h.summarized.slice(0,SETUP_AI_LIMIT)),new Set(newest));
    await settle(()=>h.summarized.length===count);
  }finally{await h.cleanup();}
});

test('without an AI key setup still syncs and says the AI pass was skipped',async()=>{
  const h=await setupHarness({ai:false});
  try{
    await h.service.invoke('account.connect',{provider:'jmap',setup:true});
    const done=await h.service.invoke('setup.run') as SetupProgress;
    assert.equal(done.state,'done');assert.equal(done.ai?.state,'skipped');
    assert.equal((await h.service.invoke('state.get') as AppState).threads.length,3);
  }finally{await h.cleanup();}
});

test('a failed first sync shows the host’s reason, and Retry recovers',async()=>{
  const h=await setupHarness({fail:'Gmail API has not been used in project 123 before or it is disabled.'});
  try{
    await h.service.invoke('account.connect',{provider:'jmap',setup:true});
    const failed=await h.service.invoke('setup.run') as SetupProgress;
    assert.equal(failed.state,'failed');assert.equal(failed.accounts[0].phase,'error');
    assert.match(failed.accounts[0].error!,/Could not sync alex@example\.test\. Gmail API has not been used in project 123/);
    h.control.fail='';
    const retried=await h.service.invoke('setup.run') as SetupProgress;
    assert.equal(retried.state,'done');assert.equal(retried.accounts[0].phase,'done');assert.equal(retried.accounts[0].error,undefined);
    assert.equal(retried.ai?.state,'done');
  }finally{await h.cleanup();}
});

test('setup with only demo mail finishes at once',async()=>{
  const dataDir=await folder();
  try{
    const service=await open(dataDir);
    try{await service.invoke('demo.reset');const done=await service.invoke('setup.run') as SetupProgress;assert.deepEqual(done,{state:'done',accounts:[],ai:{state:'done',done:0,total:0,background:0}});}
    finally{await service.close();}
  }finally{await rm(dataDir,{recursive:true,force:true});}
});

test('closing onboarding before its loading screen does not leave new mail without AI',async()=>{
  const h=await setupHarness();
  try{
    let release!:()=>void;h.control.hold=new Promise(r=>{release=r;});
    await h.service.invoke('account.connect',{provider:'jmap',setup:true});
    // The onboarding window is closed (or skipped) while the connect-time sync is still running.
    await h.service.invoke('settings.update',{patch:{onboardingDone:true}});
    release();
    await settle(()=>h.summarized.length===3);
  }finally{await h.cleanup();}
});
