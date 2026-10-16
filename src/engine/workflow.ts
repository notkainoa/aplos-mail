import type { Account, Thread } from '../shared/types';

/**
 * Aplos workflow state that syncs between devices through an encrypted blob in each account's hidden
 * "Aplos" folder. Trash and spam are host state, so a thread there has no workflow fields of its own.
 */
export interface WorkflowFields {
  status:'new'|'done'|'later';
  replyStatus:Thread['replyStatus'];
  reminderAt?:string;
  reminderFired?:true;
  dueDate?:string;
  todo?:string;
  hiddenFromHome?:true;
}
export interface WorkflowEntry { fields:WorkflowFields; /** Epoch ms of the edit. */ at:number; device:string }
/** Last writer wins per thread; ties go to the larger device ID, then the larger fields. */
export interface WorkflowLog { version:1; entries:Record<string,WorkflowEntry> }
export interface WorkflowPatch { threadId:string; patch:Partial<Thread> }

/**
 * How threads are keyed in one account's log. Gmail thread IDs, Graph conversation IDs and JMAP thread IDs
 * are assigned by the host and identical on every device (`thread`). IMAP thread keys are built locally from
 * whichever messages a device happened to index, so IMAP keys by the thread's root Message-ID (`message`).
 * Hosts with their own IDs do not key by Message-ID because they can split one References chain into
 * several threads (Gmail does on a subject change), which would make those threads share an entry.
 */
export type KeyScheme='thread'|'message';
export const keySchemeFor=(provider:Account['provider']):KeyScheme=>provider==='imap'?'message':'thread';

export const WORKFLOW_RETENTION_MS=180*86_400_000;
export const WORKFLOW_MAX_ENTRIES=20_000;

export const emptyWorkflowLog=():WorkflowLog=>({version:1,entries:{}});
const ids=(value:string|undefined)=>[...(value??'').matchAll(/<([^<>\s]+)>/g)].map(m=>m[1]);
const bare=(value:string|undefined)=>value?.trim().replace(/^<|>$/g,'').trim()||undefined;

/**
 * Stable key for a thread within its account's log, or undefined when the thread has nothing stable.
 * `message`: the first References entry of the oldest message (the conversation's root, which every reply
 * carries), else that message's own Message-ID; falls back to the remote ID.
 */
export function threadKey(thread:Thread, scheme:KeyScheme='thread'):string|undefined {
  if(scheme==='message'){
    const first=[...thread.messages].sort((a,b)=>a.date.localeCompare(b.date))[0];
    const root=ids(first?.references)[0]??bare(first?.internetId);
    if(root)return `m:${root}`;
  }
  return thread.remoteId?`t:${thread.remoteId}`:undefined;
}

/** The thread's workflow fields in canonical form (unset and false values omitted), or undefined in Trash/Spam. */
export function workflowFields(thread:Thread):WorkflowFields|undefined {
  if(thread.status==='trash'||thread.status==='spam')return undefined;
  return {status:thread.status,replyStatus:thread.replyStatus??'none',...(thread.reminderAt?{reminderAt:thread.reminderAt}:{}),...(thread.reminderFired?{reminderFired:true as const}:{}),
    ...(thread.dueDate?{dueDate:thread.dueDate}:{}),...(thread.todo?{todo:thread.todo}:{}),...(thread.hiddenFromHome?{hiddenFromHome:true as const}:{})};
}
const FIELD_ORDER=['status','replyStatus','reminderAt','reminderFired','dueDate','todo','hiddenFromHome'] as const;
const canonical=(fields:WorkflowFields)=>JSON.stringify(FIELD_ORDER.map(k=>fields[k]??null));
export const sameFields=(a:WorkflowFields|undefined,b:WorkflowFields|undefined)=>!!a&&!!b&&canonical(a)===canonical(b);
const plain=(fields:WorkflowFields)=>(fields.status==='new'||fields.status==='done')&&fields.replyStatus==='none'&&FIELD_ORDER.slice(2).every(k=>fields[k]===undefined);

/** Positive when `a` wins over `b`. A total order, so merging does not depend on argument order. */
function compare(a:WorkflowEntry,b:WorkflowEntry):number {
  if(a.at!==b.at)return a.at-b.at;
  if(a.device!==b.device)return a.device<b.device?-1:1;
  const x=canonical(a.fields),y=canonical(b.fields);
  return x===y?0:x<y?-1:1;
}
const sameEntry=(a:WorkflowEntry|undefined,b:WorkflowEntry|undefined)=>a===b||(!!a&&!!b&&compare(a,b)===0);
export function sameLog(a:WorkflowLog|undefined,b:WorkflowLog|undefined):boolean {
  const x=a?.entries??{},y=b?.entries??{},keys=Object.keys(x);
  return keys.length===Object.keys(y).length&&keys.every(k=>sameEntry(x[k],y[k]));
}

/**
 * Record the user's own edits. Pass the threads the user changed on this device since the log was last
 * written, not every thread: a status that mail sync derived from the host (an archive seen as Done) is
 * not an edit and would otherwise override the Later that another device set. Threads whose fields
 * already match their entry add nothing.
 */
export function recordLocal(log:WorkflowLog, edited:Thread[], device:string, now:number, scheme:KeyScheme='thread'):WorkflowLog {
  const entries={...log.entries};
  for(const thread of edited){
    const key=threadKey(thread,scheme),fields=workflowFields(thread);if(!key||!fields)continue;
    const current=entries[key];
    if(current&&sameFields(current.fields,fields))continue;
    // Never record an edit as older than the entry it replaces, even if this device's clock is behind.
    entries[key]={fields,at:Math.max(now,(current?.at??0)+1),device};
  }
  return {version:1,entries};
}

/** Union of both logs keeping the winning entry per key: commutative, associative and idempotent. */
export function mergeLogs(a:WorkflowLog, b:WorkflowLog):WorkflowLog {
  const entries={...a.entries};
  for(const [key,entry] of Object.entries(b.entries)){const mine=entries[key];if(!mine||compare(entry,mine)>0)entries[key]=entry;}
  return {version:1,entries};
}

/**
 * Patches for local threads whose entry in `merged` is news to this device, meaning it differs from the
 * entry in `known` (the log this device last wrote or read, plus its own recorded edits). An entry already
 * known is never applied again, so a host change made after it (for example moving the thread back to the
 * inbox) is not undone on every sync. Mail from someone else that arrived after the edit keeps the thread's
 * Home state (status, hidden from Home, reply status); the edit's todo, due date and reminder still apply.
 */
export function workflowPatches(merged:WorkflowLog, threads:Thread[], known:WorkflowLog=emptyWorkflowLog(), scheme:KeyScheme='thread'):WorkflowPatch[] {
  const patches:WorkflowPatch[]=[];
  for(const thread of threads){
    const key=threadKey(thread,scheme),entry=key?merged.entries[key]:undefined,fields=workflowFields(thread);
    if(!entry||!fields||sameEntry(entry,known.entries[key!]))continue;
    const target=entry.fields,arrived=thread.messages.some(m=>!m.sent&&Date.parse(m.date)>entry.at);
    const patch:Partial<Thread>={};
    if(!arrived){
      if(target.status!==fields.status)patch.status=target.status;
      if(target.replyStatus!==fields.replyStatus)patch.replyStatus=target.replyStatus;
      if(target.hiddenFromHome!==fields.hiddenFromHome)patch.hiddenFromHome=target.hiddenFromHome??false;
    }
    // Cleared text fields are patched as present-but-undefined keys; apply patches with a spread.
    for(const k of ['reminderAt','dueDate','todo'] as const)if(target[k]!==fields[k])patch[k]=target[k];
    if(target.reminderFired!==fields.reminderFired)patch.reminderFired=target.reminderFired??false;
    if(Object.keys(patch).length)patches.push({threadId:thread.id,patch});
  }
  return patches;
}

/** Drop old entries that say nothing beyond the host's own state, then keep the newest `max` entries. */
export function compactLog(log:WorkflowLog, now:number, max=WORKFLOW_MAX_ENTRIES, retention=WORKFLOW_RETENTION_MS):WorkflowLog {
  const kept=Object.entries(log.entries).filter(([,e])=>!(e.at<now-retention&&plain(e.fields)));
  if(kept.length>max)kept.sort(([ka,a],[kb,b])=>compare(b,a)||(ka<kb?-1:1)).splice(max);
  return {version:1,entries:Object.fromEntries(kept)};
}

export interface Reconciled {
  /** The log to keep locally as the next `known` log, and to write to the host when `write` is true. */
  log:WorkflowLog;
  patches:WorkflowPatch[];
  write:boolean;
}
/**
 * One sync round for an account. `known` is the log this device kept from the previous round (undefined on
 * its first round, so the host's log is taken as is rather than overridden); `remote` is the log read from
 * the host (undefined when there is none yet); `edited` are the threads the user changed since `known`.
 */
export function reconcileWorkflow(input:{known?:WorkflowLog; remote?:WorkflowLog; edited:Thread[]; threads:Thread[]; device:string; now:number; scheme?:KeyScheme}):Reconciled {
  const known=input.known??emptyWorkflowLog(),local=recordLocal(known,input.edited,input.device,input.now,input.scheme);
  const log=compactLog(input.remote?mergeLogs(local,input.remote):local,input.now);
  return {log,patches:workflowPatches(log,input.threads,local,input.scheme),write:!sameLog(log,input.remote)};
}

/** Validate a decrypted log; throws on anything that is not a version 1 log. */
export function parseWorkflowLog(value:unknown):WorkflowLog {
  const fail=()=>{throw new Error('Synced workflow data is not in a format this version of Aplos understands.');};
  if(!value||typeof value!=='object')return fail();
  const raw=value as {version?:unknown;entries?:unknown};
  if(raw.version!==1||!raw.entries||typeof raw.entries!=='object'||Array.isArray(raw.entries))return fail();
  const text=(v:unknown)=>typeof v==='string'&&v.length>0&&v.length<=10_000?v:undefined;
  const entries:Record<string,WorkflowEntry>={};
  for(const [key,item] of Object.entries(raw.entries as Record<string,any>)){
    const f=item?.fields;
    if(!f||typeof item.at!=='number'||!Number.isFinite(item.at)||typeof item.device!=='string'||!['new','done','later'].includes(f.status)||!['none','needs-reply','awaiting-reply'].includes(f.replyStatus))continue;
    const fields:WorkflowFields={status:f.status,replyStatus:f.replyStatus};
    for(const k of ['reminderAt','dueDate','todo'] as const){const v=text(f[k]);if(v)fields[k]=v;}
    if(f.reminderFired===true)fields.reminderFired=true;
    if(f.hiddenFromHome===true)fields.hiddenFromHome=true;
    entries[key]={fields,at:item.at,device:item.device};
  }
  return {version:1,entries};
}
