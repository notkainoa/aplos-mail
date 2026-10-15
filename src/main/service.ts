import { randomUUID } from 'node:crypto';
import type { Account, AppState, Attachment, CalendarEvent, Conversation, Draft, Listener, Settings, Thread } from '../shared/types';
import { createDemo, defaultSettings } from './demo';
import { createStore } from './store';
import { createGroq } from './groq';
import { createGoogle } from './google';

type Groq = ReturnType<typeof createGroq>;
type Google = Awaited<ReturnType<typeof createGoogle>>;
export interface ServiceOptions {
  dataDir:string; desktop?:boolean; encrypt?:(text:string)=>Buffer; decrypt?:(cipher:Buffer)=>string;
  openExternal?:(url:string)=>Promise<unknown>; groq?:Groq; google?:Google; now?:()=>Date;
}
const clone = <T>(v:T):T => structuredClone(v);
const text = (v:unknown,max=100_000):string => {
  if (typeof v!=='string' || v.length>max) throw new Error('Invalid text or text is too long.');
  return v;
};
function object(v:unknown):Record<string,any> {
  if (!v || typeof v!=='object' || Array.isArray(v)) throw new Error('Expected an object.');
  return v as Record<string,any>;
}
function date(v:unknown):string|undefined {
  if (v===undefined || v===null || v==='') return undefined;
  if (typeof v!=='string' || !Number.isFinite(Date.parse(v))) throw new Error('Enter a valid date.');
  return new Date(v).toISOString();
}
function dateOnly(v:unknown):string|undefined {
  if(v===undefined||v===null||v==='')return undefined;
  const source=text(v,100),day=source.slice(0,10);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||!Number.isFinite(Date.parse(day))||new Date(day).toISOString().slice(0,10)!==day)throw new Error('Enter a valid due date.');
  return day;
}
function enumValue<const T extends string>(v:unknown,values:readonly T[]):T {
  if (!values.includes(v as T)) throw new Error('Invalid option.');
  return v as T;
}
const stripHTML=(html:string)=>html.replace(/<[^>]*>/g,' ').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/\s+/g,' ').trim();
const escapeHTML=(value:string)=>value.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!));
function outboundHTML(draft:Draft,settings:Settings) {
  let html=draft.html;
  const include=draft.signature&&settings.signatureMode!=='never'&&(settings.signatureMode==='always'||draft.mode==='new'||draft.mode==='forward');
  if(include&&settings.signature.trim())html+=`<div data-aplos-signature="true"><br>${escapeHTML(settings.signature).replace(/\r?\n/g,'<br>')}</div>`;
  if(settings.footer)html+='<p data-aplos-footer="true">Sent with Aplos Mail</p>';
  return html;
}
const addresses=(value:string)=>value.split(/[,;]+/).map(a=>a.trim()).filter(Boolean);
function safeEmail(value:unknown):string {
  const email=text(value,320).toLowerCase().trim();
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) throw new Error('Enter a valid email address.');
  return email;
}
function validRecipients(value:string) {
  for (const addr of addresses(value)) {
    const match=addr.match(/<([^<>]+)>$/);
    safeEmail(match?match[1]:addr);
    if (/[\r\n]/.test(addr)) throw new Error('Invalid email address.');
  }
}
function threadPatch(raw:unknown):Partial<Thread> {
  const source=object(raw),patch:Partial<Thread>={};
  if ('status' in source) patch.status=enumValue(source.status,['new','done','later','trash','spam']);
  if ('importance' in source) patch.importance=enumValue(source.importance,['important','low']);
  if ('replyStatus' in source) patch.replyStatus=enumValue(source.replyStatus,['none','needs-reply','awaiting-reply']);
  for (const key of ['unread','bookmarked','hiddenFromHome','reminderFired'] as const) {
    if (key in source) { if(typeof source[key]!=='boolean') throw new Error('Invalid checkbox value.'); patch[key]=source[key]; }
  }
  if('dueDate' in source)patch.dueDate=dateOnly(source.dueDate);
  if('reminderAt' in source)patch.reminderAt=date(source.reminderAt);
  if ('reminderAt' in source) patch.reminderFired=false;
  if ('todo' in source) patch.todo=source.todo===null||source.todo===undefined?undefined:text(source.todo,2_000);
  return patch;
}
function settingsPatch(raw:unknown):Partial<Settings> {
  const source=object(raw),patch:Partial<Settings>={};
  const choices:Partial<Record<keyof Settings,readonly string[]>>={theme:['light','dark','system'],openMode:['stack','split'],triageDirection:['done-right','done-left'],doneAction:['archive','read','unread'],laterAction:['archive','read','unread'],lowAction:['archive','read','unread'],defaultReply:['reply','reply-all'],signatureMode:['always','new','never'],icon:['ink','sage','clay']};
  for(const key of Object.keys(defaultSettings) as (keyof Settings)[]) {
    if(!(key in source)) continue;
    const val=source[key];
    if(choices[key]) (patch as any)[key]=enumValue(val,choices[key]!);
    else if(typeof defaultSettings[key]==='boolean') {
      if(typeof val!=='boolean') throw new Error(`Invalid ${key} setting.`); (patch as any)[key]=val;
    } else if(key==='undoSeconds') {
      if(!Number.isInteger(val)||val<0||val>60) throw new Error('Undo send must be between 0 and 60 seconds.'); patch.undoSeconds=val;
    } else if(key==='accountNotifications') {
      const entries=object(val); if(Object.values(entries).some(v=>typeof v!=='boolean')) throw new Error('Invalid notification preferences.');
      patch.accountNotifications=Object.fromEntries(Object.entries(entries).map(([k,v])=>[text(k,200),v]));
    } else (patch as any)[key]=text(val,key==='signature'?20_000:1_000);
  }
  return patch;
}
function attachments(raw:unknown):Attachment[] {
  if(!Array.isArray(raw)||raw.length>30) throw new Error('Attach at most 30 files.');
  let total=0;
  return raw.map(item=>{
    const a=object(item),data=a.data===undefined?undefined:text(a.data,35_000_000);
    if(data&&!/^[a-zA-Z0-9+/]*={0,2}$/.test(data)) throw new Error('Invalid attachment data.');
    const size=data?Buffer.from(data,'base64').byteLength:Number(a.size);
    if(!Number.isFinite(size)||size<0) throw new Error('Invalid attachment size.');
    total+=size; if(total>25*1024*1024) throw new Error('Attachments must total less than 25 MB.');
    return {id:text(a.id||randomUUID(),200),name:text(a.name,500).replace(/[\r\n]/g,''),type:text(a.type||'application/octet-stream',200),size,data,
      ...(a.contentId?{contentId:text(a.contentId,200)}:{}),...(a.gmailAttachmentId?{gmailAttachmentId:text(a.gmailAttachmentId,1000)}:{}),...(a.messageId?{messageId:text(a.messageId,1000)}:{})};
  });
}

export async function createService(options:ServiceOptions) {
  const now=options.now||(()=>new Date());
  const store=createStore(options.dataDir);
  let state=store.read()||createDemo(now());
  state.settings={...clone(defaultSettings),...state.settings};
  state.sync={...state.sync,busy:false};
  for(const thread of state.threads)if(thread.dueDate)thread.dueDate=dateOnly(thread.dueDate);
  const groq=options.groq||createGroq();
  const google=options.google||await createGoogle({dataDir:options.dataDir,encrypt:options.encrypt,decrypt:options.decrypt,openExternal:options.openExternal});
  const listeners=new Set<Listener>(),timers=new Map<string,ReturnType<typeof setTimeout>>(),requests=new Map<string,AbortController>(),sending=new Set<string>();
  const jobs=new Set<Promise<void>>();
  const undo:Array<Thread[]> = [];
  let closed=false;
  const emit=(type:string,payload?:unknown)=>{for(const listener of listeners) {try{listener({type,payload:clone(payload)});}catch{/* A closed renderer must not interrupt persistence. */}}};
  function commit(next:AppState) { store.write(next); state=next; emit('state',state); }
  function change(fn:(next:AppState)=>void) {const next=clone(state);fn(next);commit(next);}
  function account(id:string):Account {const result=state.accounts.find(a=>a.id===id);if(!result)throw new Error('Account not found.');return clone(result);}
  function thread(id:string):Thread {const result=state.threads.find(t=>t.id===id);if(!result)throw new Error('Message not found.');return clone(result);}
  function draft(id:string):Draft {const result=state.drafts.find(d=>d.id===id);if(!result)throw new Error('Draft not found.');return clone(result);}
  function stopSend(id:string) {const timer=timers.get(id);if(timer)clearTimeout(timer);timers.delete(id);}
  function checkReminders() {
    const due=state.threads.filter(t=>t.status==='later'&&t.reminderAt&&!t.reminderFired&&Date.parse(t.reminderAt)<=now().getTime());
    if(!due.length)return;
    change(s=>{for(const t of s.threads)if(due.some(d=>d.id===t.id)){t.status='new';t.hiddenFromHome=false;t.reminderFired=true;t.unread=true;}});
    for(const t of due)emit('reminder',{threadId:t.id,title:t.subject});
  }
  function sendError(id:string,error:unknown) {
    const message=error instanceof Error?error.message:'Sending failed. Please try again.';
    if(state.drafts.some(d=>d.id===id))change(s=>{const d=s.drafts.find(d=>d.id===id)!;delete d.pendingSendAt;d.sendError=message;});
  }
  async function deliver(id:string) {
    stopSend(id);
    if(closed||sending.has(id))return;
    const original=state.drafts.find(d=>d.id===id);
    if(!original?.pendingSendAt)return;
    if(Date.parse(original.pendingSendAt)>now().getTime()+20){scheduleSend(original);return;}
    sending.add(id);
    try {
      const d=clone(original),a=account(d.accountId);
      if(!a.connected)throw new Error('Reconnect this account before sending.');
      d.html=outboundHTML(d,state.settings);
      const remote=a.provider==='google'?await google.send(a,d):undefined;
      const sentAt=now().toISOString();
      change(s=>{
        s.drafts=s.drafts.filter(item=>item.id!==id);
        const message={id:randomUUID(),from:a.email,fromName:a.name,to:addresses(d.to),cc:addresses(d.cc),date:sentAt,text:stripHTML(d.html),html:d.html,attachments:d.attachments,sent:true};
        const existing=d.threadId?s.threads.find(t=>t.id===d.threadId):undefined;
        if(existing){existing.messages.push(message);existing.date=sentAt;existing.replyStatus='awaiting-reply';existing.status='done';existing.unread=false;}
        else s.threads.unshift({id:remote?.threadId?`${a.id}:${remote.threadId}`:randomUUID(),...(remote?.threadId?{gmailId:remote.threadId}:{}),accountId:a.id,subject:d.subject,summary:stripHTML(d.html).slice(0,240),messages:[message],date:sentAt,unread:false,status:'done',importance:'important',bookmarked:false,replyStatus:'awaiting-reply'});
      });
      emit('sent',{draftId:id,playSound:state.settings.sendSound});
    }catch(error){sendError(id,error);}finally{sending.delete(id);}
  }
  function scheduleSend(d:Draft) {
    stopSend(d.id);if(!d.pendingSendAt)return;
    const remaining=Math.max(0,Date.parse(d.pendingSendAt)-now().getTime());
    const timer=setTimeout(()=>{const job=deliver(d.id).catch(()=>{emit('error',{message:'The send result could not be saved. Check local storage before retrying this draft.'});});jobs.add(job);void job.finally(()=>jobs.delete(job));},Math.min(remaining,2_147_483_647));
    timer.unref?.();timers.set(d.id,timer);
  }
  async function ai<T>(payload:Record<string,any>,fn:(signal:AbortSignal)=>Promise<T>):Promise<T> {
    const id=payload.requestId?text(payload.requestId,200):randomUUID();
    if(requests.has(id))throw new Error('This AI request is already running.');
    const controller=new AbortController();requests.set(id,controller);emit('ai.start',{requestId:id});
    try {const result=await fn(controller.signal);if(controller.signal.aborted)throw new Error('AI request cancelled.');return result;}
    finally{requests.delete(id);emit('ai.end',{requestId:id});}
  }
  async function updateThreads(ids:string[],patch:Partial<Thread>,recordUndo=true) {
    if(!Array.isArray(ids)||!ids.length||ids.length>1_000)throw new Error('Choose one or more messages.');
    const before=[...new Set(ids)].map(id=>thread(text(id,300)));
    const updates=before.map(t=>{
      const p={...patch};
      const action=patch.status==='done'?state.settings.doneAction:patch.status==='later'?state.settings.laterAction:patch.importance==='low'?state.settings.lowAction:undefined;
      if(action==='read')p.unread=false;
      if(action==='unread')p.unread=true;
      if(action==='archive'&&t.labels)p.labels=t.labels.filter(l=>l!=='INBOX');
      if(patch.status==='new'){p.hiddenFromHome=false;if(t.labels&&!t.labels.includes('INBOX'))p.labels=[...t.labels,'INBOX'];}
      return {thread:t,patch:p};
    });
    // Commit each successful provider mutation so a later account failure cannot hide it.
    const completed:Thread[]=[];
    try{
      for(const update of updates){const a=account(update.thread.accountId);if(a.provider==='google')await google.updateThread(a,update.thread,update.patch);
        change(s=>{const index=s.threads.findIndex(t=>t.id===update.thread.id);s.threads[index]={...s.threads[index],...update.patch};});completed.push(update.thread);}
    }finally{if(recordUndo&&completed.length){undo.push(completed);if(undo.length>50)undo.shift();}}
    return clone(state);
  }
  async function classifyIncoming(fresh:Thread[],a:Account):Promise<string[]> {
    if(!fresh.length||!groq.available)return [];
    let cursor=0,classificationFailures=0,calendarFailures=0,cancelled=false;
    try{
      await ai({requestId:`sync-ai-${a.id}`},async signal=>{
        // Bound concurrency while keeping a first sync responsive for larger mailboxes.
        await Promise.all(Array.from({length:Math.min(3,fresh.length)},async()=>{
          while(cursor<fresh.length&&!signal.aborted){
            const candidate=fresh[cursor++];
            if(!state.threads.some(t=>t.id===candidate.id))continue;
            const before=thread(candidate.id);
            try{
              const result=await groq.summarize(before,signal);
              if(signal.aborted)break;
              const classified=threadPatch({importance:result.importance||before.importance,replyStatus:result.replyStatus||before.replyStatus,todo:result.todo,dueDate:result.dueDate});
              if(typeof result.summary==='string')classified.summary=result.summary.slice(0,10_000);
              change(s=>{const current=s.threads.find(t=>t.id===candidate.id);if(!current)return;
                for(const key of ['importance','replyStatus','todo','dueDate','summary'] as const){
                  // An edit made while Groq was running always wins over its response.
                  if(current[key]===before[key]&&key in classified)(current as any)[key]=classified[key];
                }
              });
            }catch{if(signal.aborted)break;classificationFailures++;}
            if(state.settings.autoCalendar&&a.calendarConnected&&!signal.aborted){
              try{
                const extracted=await groq.extractEvents(before,signal);
                for(const event of extracted){
                  if(signal.aborted||!state.settings.autoCalendar)break;
                  if(!event.title||!event.start||!event.end||!Number.isFinite(Date.parse(event.start))||Date.parse(event.end)<=Date.parse(event.start))continue;
                  await invoke('calendar.save',{event:{...event,id:randomUUID(),accountId:a.id,threadId:before.id,calendarId:event.calendarId||'primary'}});
                }
              }catch{if(signal.aborted)break;calendarFailures++;}
            }
          }
        }));
        return undefined;
      });
    }catch{cancelled=true;}
    const warnings:string[]=[];
    if(classificationFailures)warnings.push(`Mail synced for ${a.email}, but AI could not classify ${classificationFailures} new thread${classificationFailures===1?'':'s'}. Use Summarize to retry.`);
    if(calendarFailures)warnings.push(`Mail synced for ${a.email}, but automatic calendar extraction or saving failed for ${calendarFailures} thread${calendarFailures===1?'':'s'}. Review the message and retry.`);
    if(cancelled)warnings.push(`Mail synced for ${a.email}; automatic AI processing was cancelled.`);
    for(const message of warnings)emit('error',{message});
    return warnings;
  }
  async function sync(accountId?:string) {
    if(state.sync.busy) return clone(state);
    const accounts=accountId?[account(accountId)]:clone(state.accounts);
    change(s=>{s.sync={...s.sync,busy:true,error:undefined};});
    const errors:string[]=[];
    try{
      for(const a of accounts.filter(a=>a.provider==='google'&&a.connected)){
        try{
          const incoming=await google.sync(a);
          const fresh=incoming.filter(t=>t.status==='new'&&!state.threads.some(old=>old.id===t.id)&&!t.messages.some(m=>state.blockedSenders.includes(m.from.toLowerCase())));
          const since=Date.parse(state.sync.lastSync||now().toISOString());
          const arrivals=incoming.filter(t=>t.unread&&t.status==='new'&&Date.parse(t.date)>since&&!state.threads.some(old=>old.id===t.id)&&!t.messages.some(m=>state.blockedSenders.includes(m.from.toLowerCase())));
          let events:CalendarEvent[]|undefined;
          if(a.calendarConnected)try{events=await google.listEvents(a);}catch{/* Mail sync remains available without Calendar permission. */}
          change(s=>{
            for(const t of incoming){if(t.messages.some(m=>s.blockedSenders.includes(m.from.toLowerCase())))t.status='spam';const index=s.threads.findIndex(old=>old.id===t.id);if(index<0)s.threads.push(t);else {
              const old=s.threads[index];s.threads[index]={...t,todo:old.todo,dueDate:old.dueDate,reminderAt:old.reminderAt,reminderFired:old.reminderFired,bookmarked:old.bookmarked,hiddenFromHome:old.hiddenFromHome,importance:old.importance,replyStatus:old.replyStatus,summary:old.summary||t.summary,
                status:old.status==='later'&&t.status!=='trash'&&t.status!=='spam'?'later':t.status};
            }}
            if(events){s.events=s.events.filter(e=>e.accountId!==a.id||!e.googleId);for(const event of events)if(!s.events.some(e=>e.googleId===event.googleId&&e.accountId===event.accountId))s.events.push(event);}
            const acc=s.accounts.find(x=>x.id===a.id)!;delete acc.error;
          });
          if(state.settings.notifications&&state.settings.accountNotifications[a.id]!==false)for(const t of arrivals.slice(0,3))emit('notification',{title:t.messages.at(-1)?.fromName||'New mail',body:t.subject,threadId:t.id,accountId:a.id});
          errors.push(...await classifyIncoming(fresh,a));
        }catch{const message=`Could not sync ${a.email}. Reconnect the account or try again.`;errors.push(message);change(s=>{s.accounts.find(x=>x.id===a.id)!.error=message;});}
      }
    }finally{change(s=>{s.sync={busy:false,lastSync:now().toISOString(),...(errors.length?{error:errors.join(' ')}:{})};});}
    checkReminders();return clone(state);
  }
  async function invoke(method:string,raw:unknown={}):Promise<any> {
    if(closed)throw new Error('The mailbox is closed.');
    const p=object(raw??{});
    switch(method){
      case 'state.get':checkReminders();return clone(state);
      case 'capabilities.get':return {groq:groq.available,google:google.available,desktop:!!options.desktop,version:'0.1.0'};
      case 'settings.update':change(s=>{s.settings={...s.settings,...settingsPatch(p.patch)};});return clone(state);
      case 'account.select':{const id=text(p.id,300);if(id!=='all')account(id);change(s=>{s.selectedAccountId=id;});return clone(state);}
      case 'account.connect':{const a=await google.connect();change(s=>{s.accounts=s.accounts.filter(old=>old.id!==a.id);s.accounts.push(a);s.selectedAccountId=a.id;s.settings.onboardingDone=true;});return sync(a.id);}
      case 'account.disconnect':{const a=account(text(p.id,300));
        if(state.drafts.some(d=>d.accountId===a.id&&sending.has(d.id)))throw new Error('Wait for the message to finish sending.');
        if(a.provider==='google')await google.disconnect(a.id);
        for(const d of state.drafts.filter(d=>d.accountId===a.id))stopSend(d.id);
        change(s=>{s.accounts=s.accounts.filter(x=>x.id!==a.id);s.threads=s.threads.filter(t=>t.accountId!==a.id);s.drafts=s.drafts.filter(d=>d.accountId!==a.id);s.events=s.events.filter(e=>e.accountId!==a.id);if(s.selectedAccountId===a.id)s.selectedAccountId='all';delete s.settings.accountNotifications[a.id];});undo.length=0;return clone(state);}
      case 'sync':return sync(p.accountId?text(p.accountId,300):undefined);
      case 'demo.reset':{
        if(sending.size)throw new Error('Wait for sending to finish before resetting.');
        for(const d of state.drafts)stopSend(d.id);
        // Reset synthetic data without deleting real connected accounts or their mail.
        const fresh=createDemo(now());
        for(const a of state.accounts.filter(a=>a.provider==='google'))fresh.accounts.push(a);
        const live=new Set(fresh.accounts.filter(a=>a.provider==='google').map(a=>a.id));
        fresh.threads.push(...state.threads.filter(t=>live.has(t.accountId)));fresh.drafts.push(...state.drafts.filter(d=>live.has(d.accountId)));fresh.events.push(...state.events.filter(e=>live.has(e.accountId)));
        fresh.settings=clone(state.settings);commit(fresh);undo.length=0;for(const d of state.drafts)scheduleSend(d);return clone(state);
      }
      case 'thread.update':return updateThreads(p.ids,threadPatch(p.patch));
      case 'home.hide':return updateThreads(p.ids,{hiddenFromHome:true});
      case 'thread.undo':{
        const previous=undo.at(-1);if(!previous)throw new Error('There is nothing to undo.');
        for(const old of previous){const current=thread(old.id),a=account(current.accountId),patch:Partial<Thread>={};
          for(const key of ['status','unread','importance','bookmarked','replyStatus','dueDate','reminderAt','reminderFired','todo','hiddenFromHome','labels'] as const)(patch as any)[key]=old[key];
          if(a.provider==='google')await google.updateThread(a,current,patch);change(s=>{const index=s.threads.findIndex(t=>t.id===old.id);s.threads[index]={...s.threads[index],...patch};});}
        undo.pop();return clone(state);
      }
      case 'search':{
        const query=text(p.query,2000).trim(),accountId=p.accountId&&p.accountId!=='all'?text(p.accountId,300):undefined;
        if(accountId)account(accountId);
        const tokens=query.match(/(?:[^\s"]+|"[^"]*")+/g)||[];
        const matches=state.threads.filter(t=>(!accountId||t.accountId===accountId)&&tokens.every(token=>{
          const value=token.replace(/"/g,'').toLowerCase(),colon=value.indexOf(':'),key=colon>0?value.slice(0,colon):'',term=colon>0?value.slice(colon+1):value;
          if(key==='from')return t.messages.some(m=>`${m.from} ${m.fromName}`.toLowerCase().includes(term));
          if(key==='to')return t.messages.some(m=>m.to.some(to=>to.toLowerCase().includes(term)));
          if(key==='subject')return t.subject.toLowerCase().includes(term);
          if(key==='has'&&term==='attachment')return t.messages.some(m=>m.attachments.length>0);
          if(key==='is')return term==='unread'?t.unread:term==='read'?!t.unread:term==='starred'||term==='bookmarked'?t.bookmarked:term==='important'?t.importance==='important':t.status===term;
          if(key==='in')return term==='inbox'?t.status==='new':term==='trash'||term==='spam'||term==='later'||term==='done'?t.status===term:term==='sent'?t.messages.some(m=>m.sent):false;
          if(key==='after'||key==='before'){const n=Date.parse(term);return Number.isFinite(n)&&(key==='after'?Date.parse(t.date)>n:Date.parse(t.date)<n);}
          return [t.subject,t.summary,...t.messages.map(m=>`${m.from} ${m.fromName} ${m.text}`)].join(' ').toLowerCase().includes(value);
        }));
        const found=new Map(matches.map(t=>[t.id,t]));
        const additions:Thread[]=[];
        for(const a of state.accounts.filter(a=>a.provider==='google'&&a.connected&&(!accountId||a.id===accountId))){try{for(const t of await google.search(a,query)){if(!found.has(t.id))found.set(t.id,state.threads.find(local=>local.id===t.id)||t);if(!state.threads.some(local=>local.id===t.id))additions.push(t);}}catch{/* Local results remain useful offline. */}}
        if(additions.length)change(s=>{for(const t of additions)if(!s.threads.some(local=>local.id===t.id))s.threads.push(t);});
        return clone([...found.values()].sort((a,b)=>b.date.localeCompare(a.date)));
      }
      case 'draft.save':{
        const d=object(p.draft),id=d.id?text(d.id,300):randomUUID(),existing=state.drafts.find(item=>item.id===id);account(text(d.accountId,300));
        if(existing?.pendingSendAt)throw new Error('Undo send before editing this draft.');
        if(existing&&Number(d.revision)<existing.revision)throw new Error('This draft changed in another window. Reopen it before editing.');
        const next:Draft={id,accountId:d.accountId,to:text(d.to||'',5000),cc:text(d.cc||'',5000),bcc:text(d.bcc||'',5000),subject:text(d.subject||'',2000),html:text(d.html||'',1_000_000),attachments:attachments(d.attachments||[]),
          mode:enumValue(d.mode||'new',['new','reply','reply-all','forward']),signature:!!d.signature,updatedAt:now().toISOString(),revision:(existing?.revision||0)+1};
        if(d.threadId){const t=thread(text(d.threadId,300));if(t.accountId!==d.accountId)throw new Error('Replies must use the message account.');next.threadId=t.id;}
        change(s=>{s.drafts=s.drafts.filter(item=>item.id!==id);s.drafts.push(next);});return clone(next);
      }
      case 'draft.delete':{const d=draft(text(p.id,300));if(sending.has(d.id))throw new Error('This draft is sending.');stopSend(d.id);change(s=>{s.drafts=s.drafts.filter(item=>item.id!==d.id);});return clone(state);}
      case 'draft.send':{
        const d=draft(text(p.id,300));if(d.pendingSendAt)return clone(state);
        if(!addresses(d.to).length)throw new Error('Add at least one recipient.');
        validRecipients(d.to);validRecipients(d.cc);validRecipients(d.bcc);
        if(!stripHTML(d.html)&&!d.attachments.length)throw new Error('Write a message or add an attachment before sending.');
        if(!account(d.accountId).connected)throw new Error('Reconnect this account before sending.');
        const pendingSendAt=new Date(now().getTime()+state.settings.undoSeconds*1000).toISOString();
        change(s=>{const current=s.drafts.find(item=>item.id===d.id)!;current.pendingSendAt=pendingSendAt;delete current.sendError;});scheduleSend({...d,pendingSendAt});return clone(state);
      }
      case 'draft.undoSend':{const d=draft(text(p.id,300));if(sending.has(d.id))throw new Error('Sending has started; the undo window has ended.');stopSend(d.id);change(s=>{const current=s.drafts.find(item=>item.id===d.id)!;delete current.pendingSendAt;delete current.sendError;});return clone(state);}
      case 'ai.cancel':{for(const [id,controller]of requests)if(!p.requestId||p.requestId===id)controller.abort();return {cancelled:true};}
      case 'ai.summarize':{
        const t=thread(text(p.threadId,300));const result=await ai(p,signal=>groq.summarize(t,signal));
        const patch=threadPatch(result);if(typeof result.summary==='string')patch.summary=result.summary.slice(0,10_000);
        change(s=>{const index=s.threads.findIndex(item=>item.id===t.id);if(index<0)throw new Error('The message was removed.');s.threads[index]={...s.threads[index],...patch};});return thread(t.id);
      }
      case 'ai.polish':return ai(p,signal=>groq.polish(text(p.html,1_000_000),p.instruction?text(p.instruction,10_000):undefined,signal));
      case 'ai.draft':return ai(p,signal=>groq.draft(text(p.instruction,20_000),p.threadId?thread(text(p.threadId,300)):undefined,p.draft,signal));
      case 'ai.ask':{
        const message=text(p.message,20_000).trim();if(!message)throw new Error('Write a question first.');
        let conversation:Conversation|undefined=p.conversationId?state.conversations.find(c=>c.id===p.conversationId):undefined;
        if(p.conversationId&&!conversation)throw new Error('Conversation not found.');
        conversation=clone(conversation||{id:randomUUID(),title:message.slice(0,70),messages:[],updatedAt:now().toISOString()});
        conversation.messages.push({role:'user',content:message});
        const selected=p.accountId&&p.accountId!=='all'?text(p.accountId,300):undefined;if(selected)account(selected);
        const mail=state.threads.filter(t=>(!selected||t.accountId===selected)&&t.status!=='spam'&&t.status!=='trash');
        const answer=await ai(p,signal=>groq.ask(conversation!.messages,clone(mail),signal));
        const validIds=new Set(mail.map(t=>t.id));answer.citations=answer.citations?.filter(id=>validIds.has(id));
        conversation.messages.push(answer);conversation.updatedAt=now().toISOString();
        change(s=>{s.conversations=s.conversations.filter(c=>c.id!==conversation!.id);s.conversations.push(conversation!);});return clone(conversation);
      }
      case 'ai.transcribe':{
        const audio=text(p.audio,35_000_000);if(!audio||!/^[A-Za-z0-9+/]*={0,2}$/.test(audio)||Buffer.from(audio,'base64').byteLength>25*1024*1024)throw new Error('Audio must be a base64 recording smaller than 25 MB.');
        return ai(p,signal=>groq.transcribe(audio,text(p.mimeType,200),signal));
      }
      case 'conversation.delete':change(s=>{s.conversations=s.conversations.filter(c=>c.id!==p.id);});return clone(state);
      case 'calendar.list':{
        const list:Array<{id:string;name:string;accountId:string}>=[];
        for(const a of state.accounts.filter(a=>!p.accountId||p.accountId==='all'||a.id===p.accountId)){
          if(a.provider==='demo')list.push({id:`demo-${a.id}`,name:a.id==='work'?'Work calendar':'Personal calendar',accountId:a.id});
          else list.push(...await google.listCalendars(a));
        }return list;
      }
      case 'calendar.extract':{const t=thread(text(p.threadId,300)),events=await ai(p,signal=>groq.extractEvents(t,signal));
        const a=account(t.accountId),candidates=events.map(e=>({...e,accountId:t.accountId,threadId:t.id,calendarId:e.calendarId||(a.provider==='google'?'primary':`demo-${t.accountId}`)}));
        if(state.settings.autoCalendar)for(const e of candidates)await invoke('calendar.save',{event:{...e,id:e.id||randomUUID()}});
        return candidates;
      }
      case 'calendar.save':{
        const e=object(p.event),a=account(text(e.accountId,300)),start=date(e.start),end=date(e.end);if(!start||!end||Date.parse(end)<=Date.parse(start))throw new Error('An event must end after it starts.');
        const event:CalendarEvent={id:e.id?text(e.id,300):randomUUID(),accountId:a.id,calendarId:text(e.calendarId,1000),title:text(e.title,1000),start,end,allDay:!!e.allDay,location:text(e.location||'',2000),description:text(e.description||'',20_000),guests:Array.isArray(e.guests)?e.guests.map(safeEmail):[]};
        if(!event.title.trim())throw new Error('Give the event a title.');
        if(e.threadId){thread(text(e.threadId,300));event.threadId=e.threadId;}
        const existing=state.events.find(item=>item.id===event.id);
        if(existing&&existing.accountId!==a.id)throw new Error('An event cannot move between accounts.');
        if(existing?.googleId)event.googleId=existing.googleId;if(existing?.url)event.url=existing.url;
        const duplicate=state.events.find(item=>item.id!==event.id&&item.accountId===a.id&&item.calendarId===event.calendarId&&item.title.toLowerCase()===event.title.toLowerCase()&&item.start===start);
        if(duplicate)return clone(duplicate);
        const saved=a.provider==='google'?await google.saveEvent(a,event):event;
        change(s=>{s.events=s.events.filter(item=>item.id!==saved.id);s.events.push(saved);});return clone(saved);
      }
      case 'calendar.delete':{const event=state.events.find(e=>e.id===p.id);if(!event)throw new Error('Event not found.');const a=account(event.accountId);if(a.provider==='google')await google.deleteEvent(a,event);change(s=>{s.events=s.events.filter(e=>e.id!==event.id);});return clone(state);}
      case 'attachment.get':{const t=thread(text(p.threadId,300));const attachment=t.messages.flatMap(m=>m.attachments).find(a=>a.id===p.attachmentId);if(!attachment)throw new Error('Attachment not found.');const a=account(t.accountId);if(attachment.data)return clone(attachment);if(a.provider!=='google')throw new Error('This attachment is unavailable.');return google.attachment(a,t,attachment);}
      case 'sender.block':{const email=safeEmail(p.email);const ids=state.threads.filter(t=>t.messages.some(m=>m.from.toLowerCase()===email)).map(t=>t.id);if(ids.length)await updateThreads(ids,{status:'spam'});change(s=>{if(!s.blockedSenders.includes(email))s.blockedSenders.push(email);});return clone(state);}
      case 'sender.unblock':{const email=safeEmail(p.email);change(s=>{s.blockedSenders=s.blockedSenders.filter(item=>item!==email);});return clone(state);}
      case 'thread.unsubscribe':{
        const t=thread(text(p.id,300));
        // Only return an ordinary HTTPS link already present in a message. Never POST or send mail.
        for(const m of t.messages)for(const match of (m.html||'').matchAll(/<a\b[^>]*href=["'](https:\/\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)){
          if(/unsubscribe|manage preferences/i.test(match[2])){try{const url=new URL(match[1].replace(/&amp;/g,'&'));if(url.protocol==='https:'&&!url.username&&!url.password)return {url:url.href,message:'Review the sender’s unsubscribe page before confirming.'};}catch{/* Skip malformed links. */}}
        }
        return {message:'No unsubscribe link is available. You can block this sender instead.'};
      }
      case 'data.export':return JSON.stringify(state,null,2);
      default:throw new Error(`Unknown action: ${method}`);
    }
  }
  store.write(state);checkReminders();
  for(const d of state.drafts)scheduleSend(d);
  const reminderTimer=setInterval(()=>{try{if(!closed)checkReminders();}catch{emit('error',{message:'Reminders could not be saved. Check folder permissions.'});}},30_000);reminderTimer.unref?.();
  return { invoke, subscribe(listener:Listener){listeners.add(listener);return ()=>{listeners.delete(listener);};}, async close(){closed=true;clearInterval(reminderTimer);for(const id of timers.keys())stopSend(id);for(const controller of requests.values())controller.abort();await Promise.allSettled(jobs);await google.close();listeners.clear();} };
}
