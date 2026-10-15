import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Account, AppState, Draft, Thread } from '../src/shared/types';
import type { SyncResult } from '../src/engine/provider';
import { createGoogle, GoogleError } from '../src/main/google';
import { createGroq } from '../src/main/groq';
import { createService } from '../src/main/service';

const account:Account={id:'g1',name:'Alex',email:'alex@example.test',provider:'google',connected:true,color:'#aaa'};
const remote=(id:string,patch:Partial<Thread>={}):Thread=>({id:`g1:${id}`,remoteId:id,accountId:'g1',subject:`Thread ${id}`,summary:'',date:'2026-10-14T10:00:00Z',unread:true,status:'new',importance:'important',bookmarked:false,replyStatus:'none',labels:['INBOX','UNREAD'],
  messages:[{id:`${id}-1`,from:'sam@example.test',fromName:'Sam',to:[account.email],date:'2026-10-14T10:00:00Z',text:'Hello',attachments:[]}],...patch});
const offline=()=>new GoogleError('Google could not be reached. Check your internet connection.',undefined,true);
const settle=async(fn:()=>boolean|Promise<boolean>)=>{for(let i=0;i<200;i++){if(await fn())return;await new Promise(r=>setTimeout(r,10));}assert.fail('Timed out waiting');};

async function harness() {
  const dataDir=await mkdtemp(join(tmpdir(),'aplos-queue-'));
  const base=await createGoogle({dataDir,clientId:''});
  const calls:Array<{remoteId?:string;fromStatus:string;patch:Partial<Thread>}>=[],sends:Draft[]=[];
  const control={online:true,writesDown:false,fail404:new Set<string>(),sendError:undefined as Error|undefined,sent:new Map<string,{id:string;threadId:string}>(),
    next:{threads:[remote('a'),remote('b')],flags:[],removed:[],reset:true,cursor:'1'} as SyncResult};
  const google={...base,available:true,connect:async()=>account,getSendAs:async()=>[],
    sync:async(_a:Account,cursor?:string)=>{if(!control.online)throw offline();const value=structuredClone(control.next);control.next={threads:[],flags:[],removed:[],reset:false,cursor:String(Number(cursor??0)+1)};return value;},
    updateThread:async(_a:Account,t:Pick<Thread,'remoteId'|'status'|'labels'>,patch:Partial<Thread>)=>{
      if(!control.online)throw offline();
      if(control.writesDown)throw new GoogleError('Google request failed (503). Please retry.',503,true);
      if(control.fail404.has(t.remoteId!))throw new GoogleError('Google could not find this item.',404);
      calls.push({remoteId:t.remoteId,fromStatus:t.status,patch});
    },
    send:async(_a:Account,d:Draft)=>{sends.push(structuredClone(d));if(control.sendError)throw control.sendError;const result={id:'sent-1',threadId:'sent-thread'};control.sent.set(d.messageId!,result);return result;},
    findSent:async(_a:Account,messageId:string)=>control.sent.get(messageId),
  };
  const open=()=>createService({dataDir,google,groq:createGroq({apiKey:''}),autoSyncMs:0});
  let service=await open();
  await service.invoke('account.connect');
  return {dataDir,control,calls,sends,get service(){return service;},
    async restart(){await service.close();service=await open();},
    async cleanup(){await service.close();await rm(dataDir,{recursive:true,force:true});}};
}
const get=async(h:{service:{invoke:(m:string,p?:unknown)=>Promise<any>}})=>await h.service.invoke('state.get') as AppState;

test('triage works offline, survives a restart, and reaches the host in order once it is back',async()=>{
  const h=await harness();
  try{
    h.control.online=false;
    await h.service.invoke('settings.update',{patch:{doneAction:'archive'}});
    await h.service.invoke('thread.update',{ids:['g1:a'],patch:{status:'done'}});
    await h.service.invoke('thread.update',{ids:['g1:a'],patch:{bookmarked:true}});
    let state=await get(h);
    assert.equal(state.threads.find(t=>t.id==='g1:a')!.status,'done','the change is applied locally at once');
    await settle(async()=>(await get(h)).sync.pending===2);
    await h.restart();
    assert.equal((await get(h)).sync.pending,2,'queued changes are persisted');
    h.control.online=true;
    h.control.next={threads:[],flags:[{id:'g1:a',unread:true,bookmarked:false,status:'new',labels:['INBOX','UNREAD']}],removed:[],reset:false,cursor:'5'};
    state=await h.service.invoke('sync') as AppState;
    assert.equal(state.sync.pending,undefined);
    assert.deepEqual(h.calls.map(c=>[c.remoteId,c.fromStatus,Object.keys(c.patch).sort().join()]),[['a','new','labels,status'],['a','done','bookmarked']],'changes arrive in the order they were made');
    assert.equal(h.calls[0].patch.labels?.includes('INBOX'),false,'archive removes the inbox label');
  }finally{await h.cleanup();}
});

test('a sync cannot revert a change that has not reached the host; failed writes stay queued and gone threads are dropped',async()=>{
  const h=await harness();
  try{
    h.control.fail404.add('b');
    await h.service.invoke('thread.update',{ids:['g1:b'],patch:{unread:false}});
    await settle(async()=>(await get(h)).sync.pending===undefined);
    assert.equal(h.calls.length,0,'a change for a thread the host no longer has is dropped');
    h.control.writesDown=true;
    await h.service.invoke('thread.update',{ids:['g1:a'],patch:{unread:false,bookmarked:true}});
    await settle(async()=>(await get(h)).sync.pending===1);
    // Reads work but writes still fail, so the pull brings back the host's older copy of the thread.
    h.control.next={threads:[remote('a')],flags:[],removed:[],reset:false,cursor:'7'};
    const state=await h.service.invoke('sync') as AppState,a=state.threads.find(t=>t.id==='g1:a')!;
    assert.equal(state.sync.pending,1,'the failed change stays queued');
    assert.equal(a.unread,false);assert.equal(a.bookmarked,true);
    h.control.writesDown=false;
    const manual=await h.service.invoke('sync') as AppState;
    assert.equal(manual.sync.pending,undefined,'a manual sync retries at once');
    assert.equal(manual.threads.find(t=>t.id==='g1:a')!.bookmarked,true);
    assert.equal(h.calls.at(-1)?.patch.bookmarked,true);
  }finally{await h.cleanup();}
});

test('undo is queued like any change and restores trash with an untrash',async()=>{
  const h=await harness();
  try{
    await h.service.invoke('thread.update',{ids:['g1:a'],patch:{status:'trash'}});
    await h.service.invoke('thread.undo');
    await settle(async()=>(await get(h)).sync.pending===undefined&&h.calls.length===2);
    assert.deepEqual(h.calls.map(c=>[c.fromStatus,c.patch.status]),[['new','trash'],['trash','new']]);
    assert.equal((await get(h)).threads.find(t=>t.id==='g1:a')!.status,'new');
  }finally{await h.cleanup();}
});

const draft=(id:string):Draft=>({id,accountId:'g1',to:'reader@example.test',cc:'',bcc:'',subject:`Subject ${id}`,html:'<p>Hello</p>',attachments:[],mode:'new',signature:false,updatedAt:new Date().toISOString(),revision:0});

test('an uncertain send is confirmed from Sent mail; an unconfirmed one is never retried automatically',async()=>{
  const h=await harness();
  try{
    await h.service.invoke('settings.update',{patch:{undoSeconds:0}});
    // The request reached Gmail but the answer was lost.
    h.control.sendError=offline();
    await h.service.invoke('draft.save',{draft:draft('d1')});
    await h.service.invoke('draft.send',{id:'d1'});
    await settle(async()=>{const s=await get(h);return !s.drafts.some(d=>d.id==='d1'&&!d.sendError)||!!s.drafts.find(d=>d.id==='d1')?.sendError;});
    let state=await get(h);
    assert.equal(h.sends.length,1);assert.match(state.drafts.find(d=>d.id==='d1')!.sendError!,/could not confirm/);
    assert.ok(/^<[0-9a-f-]+@example\.test>$/.test(h.sends[0].messageId!),'a stable Message-ID on the sender domain');
    // Now Gmail did receive it: the next uncertain failure finds it in Sent.
    h.control.sent.set(h.sends[0].messageId!,{id:'m',threadId:'found-thread'});
    await h.service.invoke('draft.send',{id:'d1'});
    await settle(async()=>!(await get(h)).drafts.some(d=>d.id==='d1'));
    state=await get(h);
    assert.equal(h.sends.length,2);assert.equal(h.sends[1].messageId,h.sends[0].messageId,'a retry keeps the same Message-ID');
    assert.ok(state.threads.some(t=>t.remoteId==='found-thread'&&t.messages.some(m=>m.sent)));
    h.control.sendError=new GoogleError('Google request failed (400). Please retry.',400);
    await h.service.invoke('draft.save',{draft:draft('d2')});await h.service.invoke('draft.send',{id:'d2'});
    await settle(async()=>!!(await get(h)).drafts.find(d=>d.id==='d2')?.sendError);
    assert.match((await get(h)).drafts.find(d=>d.id==='d2')!.sendError!,/400/,'a definite rejection is reported as is');
  }finally{await h.cleanup();}
});

test('a send interrupted by a crash is settled from Sent mail after restart and never sent twice',async()=>{
  const h=await harness();
  try{
    await h.service.invoke('settings.update',{patch:{undoSeconds:60}});
    for(const id of ['crash-sent','crash-lost']){await h.service.invoke('draft.save',{draft:draft(id)});await h.service.invoke('draft.send',{id});}
    await h.service.close();
    const db=new DatabaseSync(join(h.dataDir,'aplos.db'));
    const ids:Record<string,string>={};
    for(const id of ['crash-sent','crash-lost']){
      const row=db.prepare('SELECT data FROM drafts WHERE id=?').get(id) as {data:string},d=JSON.parse(row.data) as Draft;
      d.pendingSendAt=new Date(Date.now()-5_000).toISOString();d.sendAttemptAt=new Date(Date.now()-4_000).toISOString();ids[id]=d.messageId!;
      db.prepare('UPDATE drafts SET data=? WHERE id=?').run(JSON.stringify(d),id);
    }
    db.close();
    h.control.sent.set(ids['crash-sent'],{id:'m',threadId:'recovered'});
    await h.restart();
    await settle(async()=>{const s=await get(h);return !s.drafts.some(d=>d.id==='crash-sent')&&!!s.drafts.find(d=>d.id==='crash-lost')?.sendError;});
    const state=await get(h);
    assert.equal(h.sends.length,0,'nothing is sent again');
    assert.ok(state.threads.some(t=>t.remoteId==='recovered'));
    const lost=state.drafts.find(d=>d.id==='crash-lost')!;assert.match(lost.sendError!,/Check Sent mail/);assert.equal(lost.pendingSendAt,undefined);assert.equal(lost.sendAttemptAt,undefined);
  }finally{await h.cleanup();}
});

test('mail saved with Gmail-specific field names opens with provider-neutral ones',async()=>{
  const h=await harness();
  try{
    await h.service.close();
    const db=new DatabaseSync(join(h.dataDir,'aplos.db'));
    const row=db.prepare('SELECT data FROM threads WHERE id=?').get('g1:a') as {data:string},t=JSON.parse(row.data);
    delete t.remoteId;t.gmailId='a';t.messages[0].attachments=[{id:'x',name:'a.pdf',type:'application/pdf',size:1,gmailAttachmentId:'att-1',messageId:'a-1'}];
    db.prepare('UPDATE threads SET data=? WHERE id=?').run(JSON.stringify(t),'g1:a');db.close();
    await h.restart();
    const migrated=(await get(h)).threads.find(x=>x.id==='g1:a')!;
    assert.equal(migrated.remoteId,'a');assert.equal((migrated as any).gmailId,undefined);
    assert.equal(migrated.messages[0].attachments[0].remoteId,'att-1');
    await h.service.invoke('thread.update',{ids:['g1:a'],patch:{bookmarked:true}});
    await settle(()=>h.calls.length===1);
    assert.equal(h.calls[0].remoteId,'a','queued changes reach the host with the migrated ID');
  }finally{await h.cleanup();}
});
