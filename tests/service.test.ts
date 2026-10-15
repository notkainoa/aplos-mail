import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppState, Draft } from '../src/shared/types';
import { createService, type ServiceOptions } from '../src/main/service';
import { createGoogle } from '../src/main/google';
import { createGroq } from '../src/main/groq';

async function fixture(overrides:Partial<ServiceOptions>={}) {
  const dataDir=await mkdtemp(join(tmpdir(),'aplos-service-'));
  const google=await createGoogle({dataDir,clientId:''});
  const service=await createService({dataDir,google,groq:createGroq({apiKey:''}),...overrides});
  return {dataDir,google,service,async cleanup(){await service.close();await rm(dataDir,{recursive:true,force:true});}};
}
async function settle(fn:()=>Promise<boolean>) {
  for(let i=0;i<100;i++){if(await fn())return;await new Promise(r=>setTimeout(r,10));}
  assert.fail('Timed out waiting for operation');
}
const newDraft=(accountId='work'):Draft=>({id:'draft-test',accountId,to:'reader@example.com',cc:'',bcc:'',subject:'A fresh message',html:'<p>Hello from a test.</p>',attachments:[],mode:'new',signature:false,updatedAt:new Date().toISOString(),revision:0});

test('triage, undo, settings and drafts survive a restart; returned state cannot mutate storage',async()=>{
  const f=await fixture();
  try{
    const initial=await f.service.invoke('state.get') as AppState;
    assert.ok(initial.threads.length>=15);assert.equal(initial.accounts.length,2);
    initial.threads[0].subject='Not persisted';
    assert.notEqual((await f.service.invoke('state.get')).threads[0].subject,'Not persisted');
    await f.service.invoke('settings.update',{patch:{doneAction:'read',theme:'dark'}});
    await f.service.invoke('thread.update',{ids:['garden','design'],patch:{status:'done'}});
    let state=await f.service.invoke('state.get') as AppState;
    assert.equal(state.threads.find(t=>t.id==='garden')!.unread,false);
    await f.service.invoke('thread.undo');
    state=await f.service.invoke('state.get');assert.equal(state.threads.find(t=>t.id==='garden')!.status,'new');assert.equal(state.threads.find(t=>t.id==='garden')!.unread,true);
    const saved=await f.service.invoke('draft.save',{draft:newDraft()});assert.equal(saved.revision,1);
    await f.service.close();
    const reopened=await createService({dataDir:f.dataDir,google:f.google,groq:createGroq({apiKey:''})});
    try{const restored=await reopened.invoke('state.get') as AppState;assert.equal(restored.settings.theme,'dark');assert.equal(restored.drafts.find(d=>d.id==='draft-test')!.html,saved.html);}finally{await reopened.close();}
  }finally{await f.cleanup();}
});

test('undo send preserves a draft, eventual local sends appear in sent mail',async()=>{
  const f=await fixture();
  try{
    await f.service.invoke('settings.update',{patch:{undoSeconds:10}});
    await f.service.invoke('draft.save',{draft:newDraft()});await f.service.invoke('draft.send',{id:'draft-test'});
    assert.ok((await f.service.invoke('state.get')).drafts.find((d:Draft)=>d.id==='draft-test').pendingSendAt);
    await f.service.invoke('draft.undoSend',{id:'draft-test'});
    assert.equal((await f.service.invoke('state.get')).drafts.find((d:Draft)=>d.id==='draft-test').pendingSendAt,undefined);
    await f.service.invoke('settings.update',{patch:{undoSeconds:0}});await f.service.invoke('draft.send',{id:'draft-test'});
    await settle(async()=>!(await f.service.invoke('state.get')).drafts.some((d:Draft)=>d.id==='draft-test'));
    const state=await f.service.invoke('state.get') as AppState;
    assert.ok(state.threads.some(t=>t.subject==='A fresh message'&&t.messages.some(m=>m.sent)));
  }finally{await f.cleanup();}
});

test('provider failures retain a recoverable draft and pending sends resume after restart',async()=>{
  const dataDir=await mkdtemp(join(tmpdir(),'aplos-send-'));
  const base=await createGoogle({dataDir,clientId:''});let attempts=0;
  const google={...base,available:true,connect:async()=>({id:'google-test',name:'Test',email:'test@example.com',color:'#123456',provider:'google' as const,connected:true}),sync:async()=>[],send:async()=>{attempts++;throw new Error('Provider unavailable.');}};
  let service=await createService({dataDir,google,groq:createGroq({apiKey:''})});
  try{
    await service.invoke('account.connect');await service.invoke('settings.update',{patch:{undoSeconds:0}});
    await service.invoke('draft.save',{draft:newDraft('google-test')});await service.invoke('draft.send',{id:'draft-test'});
    await settle(async()=>Boolean((await service.invoke('state.get')).drafts.find((d:Draft)=>d.id==='draft-test')?.sendError));
    const failed=(await service.invoke('state.get')).drafts.find((d:Draft)=>d.id==='draft-test');
    assert.equal(failed.html,'<p>Hello from a test.</p>');assert.equal(failed.pendingSendAt,undefined);assert.equal(attempts,1);
    await service.invoke('settings.update',{patch:{undoSeconds:60}});await service.invoke('draft.send',{id:'draft-test'});await service.close();
    const path=join(dataDir,'state.json'),persisted=JSON.parse(await readFile(path,'utf8')) as AppState;
    persisted.drafts.find(d=>d.id==='draft-test')!.pendingSendAt=new Date(Date.now()-1000).toISOString();await writeFile(path,JSON.stringify(persisted));
    service=await createService({dataDir,google,groq:createGroq({apiKey:''})});
    await settle(async()=>Boolean((await service.invoke('state.get')).drafts.find((d:Draft)=>d.id==='draft-test')?.sendError));assert.equal(attempts,2);
  }finally{await service.close();await rm(dataDir,{recursive:true,force:true});}
});

test('reminders return mail to Home, calendar save is duplicate-aware and search supports filters',async()=>{
  let clock=new Date('2026-10-14T12:00:00Z');const f=await fixture({now:()=>clock});
  try{
    await f.service.invoke('thread.update',{ids:['garden'],patch:{status:'later',hiddenFromHome:true,reminderAt:'2026-10-14T13:00:00Z'}});
    clock=new Date('2026-10-14T14:00:00Z');
    const state=await f.service.invoke('state.get') as AppState,t=state.threads.find(t=>t.id==='garden')!;
    assert.equal(t.status,'new');assert.equal(t.hiddenFromHome,false);assert.equal(t.reminderFired,true);
    assert.ok(state.threads.filter(t=>t.dueDate).every(t=>/^\d{4}-\d{2}-\d{2}$/.test(t.dueDate!)));
    await f.service.invoke('thread.update',{ids:['garden'],patch:{dueDate:'2026-10-20T19:00:00Z'}});
    assert.equal((await f.service.invoke('state.get')).threads.find((t:{id:string})=>t.id==='garden').dueDate,'2026-10-20');
    await assert.rejects(f.service.invoke('thread.update',{ids:['garden'],patch:{dueDate:'2026-02-30'}}),/valid due date/);
    const event={id:'new-event',accountId:'work',calendarId:'demo-work',title:'Team walk',start:'2026-10-16T15:00:00Z',end:'2026-10-16T16:00:00Z',allDay:false,location:'Park',description:'',guests:[]};
    await f.service.invoke('calendar.save',{event});const duplicate=await f.service.invoke('calendar.save',{event:{...event,id:'duplicate'}});assert.equal(duplicate.id,'new-event');
    assert.equal((await f.service.invoke('search',{query:'from:maya has:attachment is:unread'})).length,1);
    assert.equal((await f.service.invoke('search',{query:'subject:"community garden"',accountId:'work'})).length,0);
    const attachment=await f.service.invoke('attachment.get',{threadId:'garden',attachmentId:'att-notes'});assert.match(Buffer.from(attachment.data,'base64').toString(),/Community garden/);
  }finally{await f.cleanup();}
});

test('outbound signatures respect draft choice and mode, escape text, and never polish after Send',async()=>{
  const groq={...createGroq({apiKey:''}),available:true,polish:async()=>{throw new Error('Delivery must not call AI.');}};
  const f=await fixture({groq});
  try{
    const cases:Array<{mode:Draft['mode'];signature:boolean;signatureMode:'always'|'new'|'never';expected:boolean}>=[
      {mode:'new',signature:true,signatureMode:'new',expected:true},
      {mode:'forward',signature:true,signatureMode:'new',expected:true},
      {mode:'reply',signature:true,signatureMode:'new',expected:false},
      {mode:'reply',signature:true,signatureMode:'always',expected:true},
      {mode:'new',signature:true,signatureMode:'never',expected:false},
      {mode:'new',signature:false,signatureMode:'always',expected:false},
    ];
    for(const [index,c] of cases.entries()){
      await f.service.invoke('settings.update',{patch:{undoSeconds:0,autoPolish:true,signature:'Alex <script>alert("x")</script>\nDesign & words',signatureMode:c.signatureMode,footer:true}});
      const input={...newDraft(),id:`signature-${index}`,subject:`Signature case ${index}`,mode:c.mode,signature:c.signature};
      await f.service.invoke('draft.save',{draft:input});await f.service.invoke('draft.send',{id:input.id});
      await settle(async()=>!(await f.service.invoke('state.get')).drafts.some((d:Draft)=>d.id===input.id));
      const sent=(await f.service.invoke('state.get')).threads.find((t:{subject:string})=>t.subject===input.subject).messages[0].html as string;
      assert.equal(sent.includes('data-aplos-signature'),c.expected);assert.ok(sent.includes('Sent with Aplos Mail'));
      assert.ok(sent.startsWith(input.html));assert.ok(!sent.includes('<script>'));
      if(c.expected)assert.ok(sent.includes('Alex &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;<br>Design &amp; words'));
    }
  }finally{await f.cleanup();}
});

test('sync classifies fresh mail, auto-adds definite events, and preserves edits despite visible AI failures',async()=>{
  const dataDir=await mkdtemp(join(tmpdir(),'aplos-sync-ai-'));
  const base=await createGoogle({dataDir,clientId:''});
  let calls=0;
  const template={id:'live-one',accountId:'google-ai',subject:'Review meeting',summary:'Original snippet',messages:[],date:'2026-10-16T12:00:00Z',unread:true,status:'new' as const,importance:'low' as const,bookmarked:false,replyStatus:'none' as const};
  const google={...base,available:true,connect:async()=>({id:'google-ai',name:'Test',email:'test@example.com',color:'#123456',provider:'google' as const,connected:true,calendarConnected:true}),sync:async()=>[structuredClone(template),{...structuredClone(template),id:'live-two'}],updateThread:async()=>{},listEvents:async()=>[],saveEvent:async(_account:unknown,event:any)=>({...event,googleId:'google-event'})};
  const groq={...createGroq({apiKey:''}),available:true,summarize:async(t:{id:string})=>{calls++;if(t.id==='live-two')throw new Error('AI unavailable');return {summary:'A definite review meeting',importance:'important' as const,replyStatus:'needs-reply' as const,todo:'Prepare the review',dueDate:'2026-10-18T12:00:00Z'};},extractEvents:async(t:{id:string})=>t.id==='live-one'?[{title:'Review meeting',start:'2026-10-18T12:00:00Z',end:'2026-10-18T13:00:00Z',allDay:false}]:[]};
  const service=await createService({dataDir,google,groq});
  try{
    await service.invoke('settings.update',{patch:{autoCalendar:true}});
    const state=await service.invoke('account.connect') as AppState;
    const classified=state.threads.find(t=>t.id==='live-one')!;
    assert.equal(classified.summary,'A definite review meeting');assert.equal(classified.replyStatus,'needs-reply');assert.equal(classified.dueDate,'2026-10-18');
    assert.ok(state.events.some(e=>e.title==='Review meeting'&&e.googleId==='google-event'));
    assert.match(state.sync.error!,/Mail synced.*AI could not classify/);assert.equal(state.accounts.find(a=>a.id==='google-ai')!.error,undefined);
    await service.invoke('thread.update',{ids:['live-one'],patch:{importance:'low',todo:'My own task',replyStatus:'none'}});
    const again=await service.invoke('sync') as AppState,t=again.threads.find(t=>t.id==='live-one')!;
    assert.equal(calls,2);assert.equal(t.importance,'low');assert.equal(t.todo,'My own task');assert.equal(t.replyStatus,'none');
  }finally{await service.close();await rm(dataDir,{recursive:true,force:true});}
});

test('AI proposals never send or overwrite drafts; citations are scoped and conversations persist',async()=>{
  const groq={...createGroq({apiKey:''}),available:true,
    summarize:async()=>({summary:'A volunteer invitation',todo:'Confirm the shift'}),
    ask:async()=>({role:'assistant' as const,content:'The invitation is in your personal mail.',citations:['garden','design','unknown'],proposal:{html:'<p>Sounds good.</p>'}}),
    draft:async()=>({html:'<p>An original proposal.</p>'}),
  };
  const f=await fixture({groq});
  try{
    const original=(await f.service.invoke('state.get')).drafts;
    const result=await f.service.invoke('ai.ask',{message:'What should I reply?',accountId:'personal'});
    assert.deepEqual(result.messages[1].citations,['garden']);assert.ok(result.messages[1].proposal);
    assert.deepEqual((await f.service.invoke('state.get')).drafts,original);
    assert.equal((await f.service.invoke('ai.summarize',{threadId:'garden'})).summary,'A volunteer invitation');
    await f.service.invoke('ai.draft',{instruction:'Draft a reply'});assert.deepEqual((await f.service.invoke('state.get')).drafts,original);
    await f.service.close();const reopened=await createService({dataDir:f.dataDir,google:f.google,groq});
    try{assert.equal((await reopened.invoke('state.get')).conversations[0].id,result.id);}finally{await reopened.close();}
  }finally{await f.cleanup();}
});

test('AI cancellation aborts work without persisting partial state',async()=>{
  let started!:()=>void;const start=new Promise<void>(r=>{started=r;});
  const groq={...createGroq({apiKey:''}),available:true,polish:async(_html:string,_instruction?:string,signal?:AbortSignal):Promise<{html:string}>=>{
    started();return new Promise((_resolve,reject)=>signal!.addEventListener('abort',()=>reject(new Error('AI request cancelled.')),{once:true}));
  }};
  const f=await fixture({groq});
  try{const work=f.service.invoke('ai.polish',{requestId:'cancel-test',html:'<p>hi</p>'});await start;await f.service.invoke('ai.cancel',{requestId:'cancel-test'});await assert.rejects(work,/cancelled/);}
  finally{await f.cleanup();}
});

test('validation prevents malformed recipients, settings, calendar ranges and stale draft writes',async()=>{
  const f=await fixture();
  try{
    await assert.rejects(f.service.invoke('settings.update',{patch:{undoSeconds:-1}}),/between/);
    await assert.rejects(f.service.invoke('thread.update',{ids:['garden'],patch:{status:'invalid'}}),/Invalid/);
    await f.service.invoke('draft.save',{draft:{...newDraft(),to:'invalid'}});await assert.rejects(f.service.invoke('draft.send',{id:'draft-test'}),/email/);
    await assert.rejects(f.service.invoke('draft.save',{draft:newDraft()}),/another window/);
    await assert.rejects(f.service.invoke('calendar.save',{event:{accountId:'work',start:'2026-01-02',end:'2026-01-01'}}),/end after/);
    await assert.rejects(f.service.invoke('ai.transcribe',{audio:'not-base64!',mimeType:'audio/webm'}),/base64/);
    const exported=JSON.parse(await f.service.invoke('data.export'));assert.equal(exported.version,1);assert.equal(exported.accounts[0].access_token,undefined);
  }finally{await f.cleanup();}
});
