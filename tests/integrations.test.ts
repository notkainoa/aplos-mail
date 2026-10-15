import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { simpleParser } from 'mailparser';
import { createGroq } from '../src/main/groq';
import { createGoogle, normalizeGmailThread } from '../src/main/google';
import type { Account, Draft, Thread } from '../src/shared/types';

const account:Account={id:'google-test',name:'Alex',email:'alex@example.test',provider:'google',connected:true,color:'#aaa'};
const thread:Thread={id:'google-test:thread1',accountId:account.id,gmailId:'thread1',subject:'Studio review',summary:'Review on Friday',messages:[{id:'m1',from:'sam@example.test',fromName:'Sam',to:[account.email],text:'Meet October 16 at 10:00 UTC for one hour.',date:'2026-10-14T10:00:00Z',attachments:[]}],date:'2026-10-14T10:00:00Z',unread:true,status:'new',importance:'important',bookmarked:false,replyStatus:'needs-reply'};
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
const encrypt=(text:string)=>Buffer.from([...Buffer.from(text)].map(x=>x^0x57));
const decrypt=(buffer:Buffer)=>Buffer.from([...buffer].map(x=>x^0x57)).toString();
async function tokenDir(expired=false) {
  const dir=await mkdtemp(join(tmpdir(),'aplos-google-test-'));
  await writeFile(join(dir,'google-tokens.enc.json'),JSON.stringify({[account.id]:encrypt(JSON.stringify({access_token:'test-access-token',refresh_token:'test-refresh-token',expiresAt:expired?0:Date.now()+3600000})).toString('base64')}));
  return dir;
}

test('Groq validates JSON results, constrains citations and uses only its own API',async()=>{
  const responses=[{summary:'Review Friday',importance:'low',replyStatus:'needs-reply',todo:'Confirm',dueDate:'2026-10-16'}, {content:'Friday review.',citations:[thread.id,'invented',thread.id],proposal:{to:'sam@example.test',html:'<p>Confirmed.</p>',accountId:'injected',pendingSendAt:'now'}},{to:'sam@example.test',html:'<p>Yes.</p>'},{html:'<p>Thank you.</p>'},{events:[{title:'Review',start:'2026-10-16T10:00:00Z',end:'2026-10-16T11:00:00Z',allDay:false,guests:['sam@example.test','invalid']},{title:'Bad',start:'tomorrow',end:'next week'}]}];
  const fetcher:typeof fetch=async(input,init)=>{
    assert.equal(String(input),'https://api.groq.com/openai/v1/chat/completions');
    assert.equal((init?.headers as Record<string,string>).Authorization,'Bearer mock-secret');
    const body=JSON.parse(init?.body as string);assert.equal(body.model,'openai/gpt-oss-120b');assert.equal(body.response_format.type,'json_object');
    return json({choices:[{message:{content:JSON.stringify(responses.shift())}}]});
  };
  const groq=createGroq({apiKey:'mock-secret',fetch:fetcher});
  assert.equal((await groq.summarize(thread)).todo,'Confirm');
  const answer=await groq.ask([{role:'user',content:'When is review?'}],[thread]);
  assert.deepEqual(answer.citations,[thread.id]);assert.equal(answer.proposal?.html,'<p>Confirmed.</p>');assert.equal(answer.proposal?.accountId,undefined);
  assert.equal((await groq.draft('Confirm',thread)).html,'<p>Yes.</p>');
  assert.equal((await groq.polish('<p>Thanks</p>')).html,'<p>Thank you.</p>');
  const events=await groq.extractEvents(thread);assert.equal(events.length,1);assert.deepEqual(events[0].guests,['sam@example.test']);
});

test('Groq protects secrets in errors, supports cancellation, and sends audio as multipart',async()=>{
  const failed=createGroq({apiKey:'DO-NOT-LEAK',fetch:async()=>{throw new Error('DO-NOT-LEAK');}});
  await assert.rejects(()=>failed.summarize(thread),error=>error instanceof Error&&!error.message.includes('DO-NOT-LEAK'));
  const controller=new AbortController();controller.abort();await assert.rejects(()=>failed.summarize(thread,controller.signal),/cancelled/);
  const groq=createGroq({apiKey:'test',fetch:async(input,init)=>{
    assert.match(String(input),/audio\/transcriptions$/);assert.ok(init?.body instanceof FormData);assert.equal(init.body.get('model'),'whisper-large-v3-turbo');assert.equal((init?.headers as Record<string,string>)['Content-Type'],undefined);
    return json({text:'Write a short thank you email'});
  }});
  assert.equal((await groq.transcribe(Buffer.from('synthetic-audio').toString('base64'),'audio/webm;codecs=opus')).text,'Write a short thank you email');
  await assert.rejects(()=>groq.transcribe('!!!','audio/webm'),/base64/);
  await assert.rejects(()=>groq.transcribe('YQ==','application/octet-stream'),/Unsupported/);
  await assert.rejects(()=>createGroq({apiKey:'test',fetch:async()=>json({choices:[{message:{content:'not json'}}]})}).summarize(thread),/invalid response/);
});

test('Desktop Google OAuth verifies state and PKCE and persists encrypted tokens',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'aplos-oauth-test-'));let authUrl:URL|undefined;let denySettings=false;
  const google=await createGoogle({dataDir:dir,clientId:'own-desktop-client',clientSecret:'own-client-secret',encrypt,decrypt,
    openExternal:async(url)=>{
      authUrl=new URL(url);assert.ok(authUrl.searchParams.get('scope')?.includes('https://www.googleapis.com/auth/gmail.settings.basic'));const callback=new URL(authUrl.searchParams.get('redirect_uri')!);assert.equal(callback.hostname,'127.0.0.1');
      callback.searchParams.set('state','bad');callback.searchParams.set('code','intercepted');assert.equal((await fetch(callback)).status,400);
      callback.searchParams.set('state',authUrl.searchParams.get('state')!);callback.searchParams.set('code','test-code');assert.equal((await fetch(callback)).status,200);
    },
    fetch:async(input,init)=>{
      if(String(input).includes('/settings/sendAs'))return denySettings?json({},403):json({sendAs:[{sendAsEmail:account.email,displayName:'Alex',isPrimary:true,signature:'<p>Alex</p>'},{sendAsEmail:'studio@example.test',displayName:'Studio',signature:'<p>Studio</p>',isDefault:true,verificationStatus:'accepted'},{sendAsEmail:'pending@example.test',verificationStatus:'pending'}]});
      if(String(input).includes('/token')){const values=new URLSearchParams(init?.body as URLSearchParams);assert.equal(values.get('client_id'),'own-desktop-client');assert.equal(values.get('code'),'test-code');assert.equal(createHash('sha256').update(values.get('code_verifier')!).digest('base64url'),authUrl!.searchParams.get('code_challenge'));return json({access_token:'oauth-access-sensitive',refresh_token:'oauth-refresh-sensitive',expires_in:3600});}
      return json({sub:'test',email:'alex@example.test',name:'Alex'});
    }
  });
  try {const result=await google.connect();assert.equal(result.id,account.id);assert.deepEqual(result.sendAs?.map(alias=>alias.email),[account.email,'studio@example.test']);assert.equal(result.sendAs?.[1].signature,'<p>Studio</p>');const disk=await readFile(join(dir,'google-tokens.enc.json'),'utf8');assert.ok(!disk.includes('oauth-access-sensitive'));assert.ok(!disk.includes('oauth-refresh-sensitive'));assert.ok(!disk.includes('own-client-secret'));denySettings=true;const fallback=await google.connect();assert.match(fallback.error??'',/primary address/);assert.deepEqual(fallback.sendAs?.map(alias=>alias.email),[account.email]);}
  finally {google.close();await rm(dir,{recursive:true,force:true});}
});

test('Google sync paginates, normalizes multipart mail, respects triage mapping, downloads attachments and sends MIME without SMTP',async()=>{
  const dir=await tokenDir();const requests:{url:string;body:any}[]=[];let sent:any;
  const raw={id:'thread1',messages:[{id:'m1',internalDate:'1791972000000',labelIds:['INBOX','UNREAD','IMPORTANT'],payload:{headers:[{name:'Subject',value:'Studio review'},{name:'From',value:'"Sam" <sam@example.test>'},{name:'To',value:'Alex <alex@example.test>'},{name:'Message-ID',value:'<original@example.test>'}],mimeType:'multipart/mixed',parts:[{partId:'0',mimeType:'text/plain',headers:[{name:'Content-Type',value:'text/plain; charset=iso-8859-1'}],body:{attachmentId:'body-text',size:40}},{partId:'1',mimeType:'text/html',body:{attachmentId:'body-html',size:50}},{partId:'2',mimeType:'text/plain',filename:'note.txt',body:{attachmentId:'a1',size:4}},{partId:'3',mimeType:'image/png',filename:'inline.png',headers:[{name:'Content-ID',value:'<image-1>'}],body:{attachmentId:'inline-file',size:4}}]}}]};
  const google=await createGoogle({dataDir:dir,clientId:'own-client',encrypt,decrypt,fetch:async(input,init)=>{
    const url=String(input),body=init?.body?JSON.parse(String(init.body)):undefined;requests.push({url,body});
    if(url.endsWith('/messages/send')) {sent=body;return json({id:'sent-id'});}
    if(url.endsWith('/attachments/body-text'))return json({data:Buffer.from([0x63,0x61,0x66,0xe9]).toString('base64url')});
    if(url.endsWith('/attachments/body-html'))return json({data:Buffer.from('<p>Hello Alex</p><img src="cid:image-1">').toString('base64url')});
    if(url.includes('/attachments/'))return json({data:Buffer.from('note').toString('base64url')});
    if(url.includes('/threads/thread1'))return json(raw);
    if(url.includes('pageToken=next'))return json({threads:[]});
    return json({threads:[{id:'thread1'}],nextPageToken:'next'});
  }});
  try {
    const synced=await google.sync(account);assert.equal(synced.length,1);const item=synced[0];assert.equal(item.messages[0].from,'sam@example.test');assert.equal(item.messages[0].html,'<p>Hello Alex</p><img src="cid:image-1">');assert.equal(item.messages[0].text,'café');assert.equal(item.messages[0].attachments.length,2);assert.ok(requests.some(r=>r.url.endsWith('/attachments/body-html')));assert.ok(!requests.some(r=>/attachments\/(a1|inline-file)$/.test(r.url)));assert.equal(item.messages[0].attachments[1].contentId,'image-1');assert.ok(requests.some(r=>r.url.includes('pageToken=next')));
    await google.updateThread(account,item,{status:'done',unread:false,labels:['INBOX']});const modify=requests.find(r=>r.url.endsWith('/modify'))!;assert.ok(modify.body.addLabelIds.includes('INBOX'));assert.ok(modify.body.removeLabelIds.includes('UNREAD'));
    const attachment=await google.attachment(account,item,item.messages[0].attachments[0]);assert.equal(Buffer.from(attachment.data!,'base64').toString(),'note');
    const draft:Draft={id:'draft-test',accountId:account.id,threadId:item.id,mode:'reply',to:'sam@example.test',cc:'',bcc:'archive@example.test',subject:'Re: Studio review',html:'<p>Confirmed.</p>',attachments:[attachment],signature:false,updatedAt:new Date().toISOString(),revision:1};
    const aliasAccount={...account,sendAs:[{email:'studio@example.test',name:'Studio',signature:'<p>Studio</p>',isDefault:true}]};await google.send(aliasAccount,{...draft,fromEmail:'studio@example.test'});assert.equal(sent.threadId,'thread1');const mail=await simpleParser(Buffer.from(sent.raw,'base64url'));assert.equal(mail.from?.value[0].address,'studio@example.test');assert.equal(mail.from?.value[0].name,'Studio');assert.equal(mail.subject,'Re: Studio review');assert.equal(mail.inReplyTo,'<original@example.test>');assert.equal(mail.attachments[0].content.toString(),'note');assert.match(mail.bcc&&!Array.isArray(mail.bcc)?mail.bcc.text:'',/archive@example.test/);
    await assert.rejects(()=>google.send(aliasAccount,{...draft,fromEmail:'unauthorized@example.test'}),/not authorized/);
    await assert.rejects(()=>google.send(account,{...draft,subject:'Bad\r\nBcc: victim@example.test'}),/line breaks/);
  } finally {google.close();await rm(dir,{recursive:true,force:true});}
});

test('Concurrent Google requests refresh once; Calendar creates, updates and deletes via explicit API calls',async()=>{
  const dir=await tokenDir(true);let refreshes=0;const requests:{url:string;method:string;body:any}[]=[];
  const google=await createGoogle({dataDir:dir,clientId:'own-client',encrypt,decrypt,fetch:async(input,init)=>{
    const url=String(input);if(url.includes('oauth2.googleapis.com/token')){refreshes++;return json({access_token:'fresh-token',expires_in:3600});}
    const body=init?.body?JSON.parse(String(init.body)):undefined;requests.push({url,method:init?.method??'GET',body});
    if(url.includes('/calendarList'))return json({items:[{id:'primary',summary:'Work'}]});
    if(init?.method==='DELETE')return new Response(null,{status:204});
    if(body)return json({id:'event-google',summary:body.summary,start:body.start,end:body.end,attendees:body.attendees});
    return json({items:[{id:'event-google',summary:'Review',start:{dateTime:'2026-10-16T10:00:00Z'},end:{dateTime:'2026-10-16T11:00:00Z'}}]});
  }});
  try {
    await Promise.all([google.listCalendars(account),google.listCalendars(account)]);assert.equal(refreshes,1);
    const events=await google.listEvents(account);assert.equal(events[0].title,'Review');
    const created=await google.saveEvent(account,{...events[0],id:'local-id',googleId:undefined});assert.equal(created.googleId,'event-google');assert.equal(created.id,'local-id');
    await google.saveEvent(account,{...created,title:'Updated'});await google.deleteEvent(account,created);
    assert.ok(requests.some(r=>r.method==='POST'&&r.body.summary==='Review'));assert.ok(requests.some(r=>r.method==='PUT'&&r.body.summary==='Updated'));assert.ok(requests.some(r=>r.method==='DELETE'));assert.ok(requests.filter(r=>r.body).every(r=>r.url.includes('sendUpdates=none')));
  } finally{google.close();await rm(dir,{recursive:true,force:true});}
});

test('Google requires own OAuth configuration and secure storage; callback times out cleanly',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'aplos-oauth-timeout-'));
  try {
    const unavailable=await createGoogle({dataDir:dir,clientId:''});await assert.rejects(()=>unavailable.connect(),/GOOGLE_CLIENT_ID/);
    const insecure=await createGoogle({dataDir:dir,clientId:'own-client'});await assert.rejects(()=>insecure.connect(),/Secure credential storage/);
    const timed=await createGoogle({dataDir:dir,clientId:'own-client',encrypt,decrypt,openExternal:async()=>{},oauthTimeoutMs:15});await assert.rejects(()=>timed.connect(),/timed out/);timed.close();
    const normalized=normalizeGmailThread({id:'empty'},account);assert.equal(normalized.subject,'(No subject)');assert.deepEqual(normalized.messages,[]);
  } finally{await rm(dir,{recursive:true,force:true});}
});
