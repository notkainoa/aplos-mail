import test from 'node:test';
import assert from 'node:assert/strict';
import { compactLog, emptyWorkflowLog, keySchemeFor, mergeLogs, reconcileWorkflow, recordLocal, sameLog, threadKey, workflowPatches, type WorkflowLog } from '../src/engine/workflow';
import { generateSyncCode, normalizeSyncCode, openWorkflow, sealWorkflow, WorkflowCryptoError } from '../src/main/workflow-crypto';
import type { Message, Thread } from '../src/shared/types';

const DAY=86_400_000,T0=Date.parse('2026-10-20T12:00:00Z');
const mail=(id:string,date:string,extra:Partial<Message>={}):Message=>({id,from:'sam@example.test',fromName:'Sam',to:['alex@example.test'],date,text:'Hi',attachments:[],internetId:`<${id}@example.test>`,...extra});
const thread=(remoteId:string,patch:Partial<Thread>={}):Thread=>({id:`acct:${remoteId}`,accountId:'acct',remoteId,subject:'Hello',summary:'',messages:[mail(`${remoteId}-1`,'2026-10-01T10:00:00Z')],date:'2026-10-01T10:00:00Z',
  unread:false,status:'new',importance:'important',bookmarked:false,replyStatus:'none',...patch});
const apply=(threads:Thread[],patches:{threadId:string;patch:Partial<Thread>}[])=>threads.map(t=>({...t,...patches.find(p=>p.threadId===t.id)?.patch}));

test('thread keys are host thread IDs, except IMAP which keys by the root Message-ID every device sees',()=>{
  assert.equal(keySchemeFor('google'),'thread');assert.equal(keySchemeFor('microsoft'),'thread');assert.equal(keySchemeFor('jmap'),'thread');assert.equal(keySchemeFor('imap'),'message');
  assert.equal(threadKey(thread('g1')),'t:g1');
  // Device A indexed the root and a reply; device B only the reply, under a different local key.
  const root=mail('root','2026-10-01T10:00:00Z'),reply=mail('reply','2026-10-02T10:00:00Z',{references:'<root@example.test>'});
  const a=thread('localA',{messages:[reply,root]}),b=thread('localB',{messages:[reply]});
  assert.equal(threadKey(a,'message'),'m:root@example.test');assert.equal(threadKey(b,'message'),threadKey(a,'message'));
  assert.equal(threadKey(thread('x',{messages:[mail('n','2026-10-01T10:00:00Z',{internetId:undefined})]}),'message'),'t:x','falls back to the remote ID');
  assert.equal(threadKey(thread('x',{remoteId:undefined,messages:[]})),undefined);
});

test('recording edits adds entries only for real changes; Trash and Spam are host state',()=>{
  const plain=thread('a'),later=thread('b',{status:'later',todo:'Call Sam',dueDate:'2026-10-25'}),trashed=thread('c',{status:'trash',todo:'x'});
  const log=recordLocal(emptyWorkflowLog(),[plain,later,trashed],'mac',T0);
  assert.deepEqual(Object.keys(log.entries),['t:a','t:b']);
  assert.deepEqual(log.entries['t:b'],{fields:{status:'later',replyStatus:'none',dueDate:'2026-10-25',todo:'Call Sam'},at:T0,device:'mac'});
  assert.equal(recordLocal(log,[later],'mac',T0+5).entries['t:b'].at,T0,'unchanged fields keep their entry');
  const done=recordLocal(log,[{...later,status:'done',todo:undefined,dueDate:undefined}],'mac',T0-50);
  assert.deepEqual(done.entries['t:b'].fields,{status:'done',replyStatus:'none'});
  assert.equal(done.entries['t:b'].at,T0+1,'an edit is never older than the entry it replaces');
  assert.equal(recordLocal(log,[{...plain,reminderFired:false,hiddenFromHome:false,todo:''}],'mac',T0+9).entries['t:a'].at,T0,'false and empty values count as unset');
});

test('merging is last-writer-wins, commutative, associative and idempotent',()=>{
  const at=(status:'new'|'done'|'later',time:number,device:string,todo?:string)=>({fields:{status,replyStatus:'none' as const,...(todo?{todo}:{})},at:time,device});
  const a:WorkflowLog={version:1,entries:{x:at('done',T0,'mac'),y:at('later',T0+5,'mac'),z:at('done',T0,'mac','one')}};
  const b:WorkflowLog={version:1,entries:{x:at('later',T0+1,'phone'),w:at('done',T0,'phone'),z:at('done',T0,'mac','two')}};
  const c:WorkflowLog={version:1,entries:{x:at('new',T0+1,'zed'),y:at('done',T0+2,'phone')}};
  const ab=mergeLogs(a,b);
  assert.equal(ab.entries.x.fields.status,'later');assert.equal(ab.entries.y.fields.status,'later');assert.equal(ab.entries.w.device,'phone');
  assert.equal(ab.entries.z.fields.todo,'two','identical time and device fall back to the fields, so both sides agree');
  assert.ok(sameLog(ab,mergeLogs(b,a)));
  assert.ok(sameLog(mergeLogs(mergeLogs(a,b),c),mergeLogs(a,mergeLogs(b,c))));
  assert.equal(mergeLogs(ab,c).entries.x.device,'zed','ties on time go to the larger device ID');
  assert.ok(sameLog(mergeLogs(ab,ab),ab));
});

test('two devices converge, and an entry already known is not applied again',()=>{
  const threads=[thread('a'),thread('b')];
  // Mac marks a as Later; the phone, on its first round, takes the host log rather than overriding it.
  const mac=reconcileWorkflow({edited:[{...threads[0],status:'later',todo:'Reply'}],threads,device:'mac',now:T0});
  assert.equal(mac.write,true);assert.deepEqual(mac.patches,[]);
  const phoneBefore=apply(threads,[{threadId:'acct:a',patch:{status:'done'}}]);// mail sync saw the archive as Done
  const phone=reconcileWorkflow({remote:mac.log,edited:[],threads:phoneBefore,device:'phone',now:T0+DAY});
  assert.deepEqual(phone.patches,[{threadId:'acct:a',patch:{status:'later',todo:'Reply'}}]);assert.equal(phone.write,false);
  let phoneThreads=apply(phoneBefore,phone.patches);
  // The phone clears the todo and marks b Done; the Mac picks both up.
  const edited=[{...phoneThreads[0],todo:undefined},{...phoneThreads[1],status:'done' as const}];phoneThreads=apply(phoneThreads,edited.map(t=>({threadId:t.id,patch:t})));
  const phone2=reconcileWorkflow({known:phone.log,remote:mac.log,edited,threads:phoneThreads,device:'phone',now:T0+2*DAY});
  assert.equal(phone2.write,true);assert.deepEqual(phone2.patches,[]);
  const macThreads=apply(threads,[{threadId:'acct:a',patch:{status:'later',todo:'Reply'}}]);
  const mac2=reconcileWorkflow({known:mac.log,remote:phone2.log,edited:[],threads:macThreads,device:'mac',now:T0+3*DAY});
  assert.deepEqual(mac2.patches,[{threadId:'acct:a',patch:{todo:undefined}},{threadId:'acct:b',patch:{status:'done'}}]);
  assert.ok(sameLog(mac2.log,phone2.log));assert.equal(mac2.write,false);
  // The user moves b back to the inbox in another mail app; the known Done entry does not undo that.
  const moved=apply(apply(macThreads,mac2.patches),[{threadId:'acct:b',patch:{status:'new'}}]);
  assert.deepEqual(reconcileWorkflow({known:mac2.log,remote:phone2.log,edited:[],threads:moved,device:'mac',now:T0+4*DAY}).patches,[]);
});

test('mail that arrived after an edit keeps the thread on Home, but the todo still syncs',()=>{
  const log=recordLocal(emptyWorkflowLog(),[thread('a',{status:'done',hiddenFromHome:true,todo:'Pay'})],'mac',T0);
  const local=thread('a',{messages:[mail('a-1','2026-10-01T10:00:00Z'),mail('a-2',new Date(T0+1000).toISOString())]});
  assert.deepEqual(workflowPatches(log,[local]),[{threadId:'acct:a',patch:{todo:'Pay'}}]);
  const sentAfter=thread('a',{messages:[mail('a-1','2026-10-01T10:00:00Z'),mail('a-2',new Date(T0+1000).toISOString(),{sent:true})]});
  assert.deepEqual(workflowPatches(log,[sentAfter]),[{threadId:'acct:a',patch:{status:'done',hiddenFromHome:true,todo:'Pay'}}],'own replies do not count as arrivals');
  assert.deepEqual(workflowPatches(log,[thread('a',{status:'spam'})]),[],'Trash and Spam are left alone');
});

test('compaction drops old entries that say nothing beyond host state, then caps by recency',()=>{
  const e=(status:'new'|'done'|'later',at:number,extra={})=>({fields:{status,replyStatus:'none' as const,...extra},at,device:'mac'});
  const log:WorkflowLog={version:1,entries:{oldDone:e('done',T0-200*DAY),oldLater:e('later',T0-200*DAY),oldTodo:e('done',T0-200*DAY,{todo:'x'}),recent:e('done',T0-DAY),newest:e('new',T0)}};
  assert.deepEqual(Object.keys(compactLog(log,T0).entries).sort(),['newest','oldLater','oldTodo','recent']);
  assert.deepEqual(Object.keys(compactLog(log,T0,2).entries).sort(),['newest','recent']);
});

test('sync codes are grouped, unambiguous and forgiving to type',()=>{
  const code=generateSyncCode();
  assert.match(code,/^([0-9A-HJKMNP-TV-Z]{4}-){6}[0-9A-HJKMNP-TV-Z]{4}$/);assert.notEqual(generateSyncCode(),code);
  assert.equal(normalizeSyncCode(` ${code.toLowerCase().replace(/-/g,' ')} `),code);
  assert.equal(normalizeSyncCode(code.replace(/-/g,'').replace(/0/g,'o').replace(/1/g,'l')),code);
  const typos=[...'0123456789ABCDEFGHJKMNPQRSTVWXYZ'].filter(c=>c!==code[0]).map(c=>c+code.slice(1));
  assert.ok(typos.filter(t=>{try{normalizeSyncCode(t);return false;}catch(e){return /typo/.test(String(e));}}).length>=29,'the check symbols catch a mistyped symbol');assert.throws(()=>normalizeSyncCode('ABCD-EFGH'),/28 letters/);assert.throws(()=>normalizeSyncCode(`${code.slice(0,-1)}U`),/28 letters/);
});

test('sealed workflow data round-trips and rejects the wrong code, tampering and oversize input',()=>{
  const code=generateSyncCode(),log=recordLocal(emptyWorkflowLog(),[thread('a',{status:'later',todo:'Ünïcode todo',reminderAt:'2026-10-21T09:00:00Z'})],'mac',T0);
  const blob=sealWorkflow(log,code);
  assert.match(blob,/^APLOS-WF1\.[\w-]+\.[\w-]+\.[\w-]+\.[\w-]+$/);assert.ok(!blob.includes('todo')&&!blob.includes('acct'),'no plaintext');
  assert.notEqual(sealWorkflow(log,code),blob,'fresh salt and IV each time');
  assert.deepEqual(openWorkflow(blob,code.toLowerCase()),log);
  assert.throws(()=>openWorkflow(blob,generateSyncCode()),(e:unknown)=>e instanceof WorkflowCryptoError&&e.reason==='code'&&/This sync code does not match/.test(e.message));
  const parts=blob.split('.'),body=Buffer.from(parts[4],'base64url');body[3]^=1;
  assert.throws(()=>openWorkflow([...parts.slice(0,4),body.toString('base64url')].join('.'),code),(e:unknown)=>e instanceof WorkflowCryptoError&&e.reason==='damaged');
  const iv=Buffer.from(parts[3],'base64url');iv[0]^=1;
  assert.throws(()=>openWorkflow([...parts.slice(0,3),iv.toString('base64url'),parts[4]].join('.'),code),(e:unknown)=>e instanceof WorkflowCryptoError&&e.reason==='damaged','the header is authenticated');
  assert.throws(()=>openWorkflow(parts.slice(0,4).join('.'),code),/damaged/);
  assert.throws(()=>openWorkflow('hello',code),/not Aplos workflow data/);assert.throws(()=>openWorkflow(blob.replace('WF1','WF2'),code),/newer version/);
  assert.throws(()=>openWorkflow('x'.repeat(2_000_001),code),(e:unknown)=>e instanceof WorkflowCryptoError&&e.reason==='size');
  // A full log of 20,000 entries still fits the size cap.
  const big:WorkflowLog={version:1,entries:Object.fromEntries(Array.from({length:20_000},(_,i)=>[`t:18f${i.toString(16).padStart(13,'0')}`,{fields:{status:i%2?'done':'later',replyStatus:'none',...(i%3?{}:{todo:`Follow up ${i}`})},at:T0+i,device:'mac-1234'}]))};
  assert.equal(Object.keys(openWorkflow(sealWorkflow(big,code),code).entries).length,20_000);
});
