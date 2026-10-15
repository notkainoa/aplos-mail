import { createServer, type Server } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import nodemailer from 'nodemailer';
import type { Account, Attachment, CalendarEvent, Draft, Message, Thread } from '../shared/types';

export interface GoogleOptions {
  dataDir:string; encrypt?:(value:string)=>Buffer; decrypt?:(value:Buffer)=>string;
  openExternal?:(url:string)=>Promise<unknown>; fetch?:typeof fetch; clientId?:string; clientSecret?:string; oauthTimeoutMs?:number;
}
interface Token {access_token:string;refresh_token?:string;expiresAt:number}
interface GmailPart {partId?:string;mimeType?:string;filename?:string;headers?:{name:string;value:string}[];body?:{data?:string;size?:number;attachmentId?:string};parts?:GmailPart[]}
interface GmailMessage {id:string;internalDate?:string;labelIds?:string[];snippet?:string;payload?:GmailPart}
interface GmailThread {id:string;messages?:GmailMessage[]}
type Json=Record<string,any>;
const gmail='https://gmail.googleapis.com/gmail/v1/users/me';
const calendar='https://www.googleapis.com/calendar/v3';
const enc=encodeURIComponent;
const header=(part:GmailPart|undefined,name:string)=>part?.headers?.find(h=>h.name.toLowerCase()===name.toLowerCase())?.value??'';
function address(value:string) { const match=value.match(/^(.*?)\s*<([^<>]+)>\s*$/); return match?{email:match[2],name:match[1].replace(/^"|"$/g,'').trim()}:{email:value.trim(),name:value.split('@')[0]}; }
function addresses(value:string) {return value.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map(v=>address(v).email).filter(Boolean);}
function flatten(part:GmailPart|undefined):GmailPart[]{return part?[part,...(part.parts??[]).flatMap(flatten)]:[];}
function decode(part:GmailPart) {
  if(!part.body?.data)return '';
  const bytes=Buffer.from(part.body.data,'base64url');
  const charset=header(part,'content-type').match(/charset\s*=\s*["']?([^;\s"']+)/i)?.[1]??'utf-8';
  try{return new TextDecoder(charset).decode(bytes);}catch{return bytes.toString('utf8');}
}
function htmlText(html:string) {return html.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,'').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/\s+/g,' ').trim();}
/** Normalize public Gmail payloads into our independent mailbox model. HTML is sanitized at display. */
export function normalizeGmailThread(raw:GmailThread,account:Account):Thread {
  const items=raw.messages??[];
  const messages:Message[]=items.map(m=>{
    const parts=flatten(m.payload),from=address(header(m.payload,'from'));
    const html=parts.filter(p=>p.mimeType==='text/html'&&!p.filename).map(decode).join('\n');
    const text=parts.filter(p=>p.mimeType==='text/plain'&&!p.filename).map(decode).join('\n')||htmlText(html)||m.snippet||'';
    const date=new Date(Number(m.internalDate)||Date.parse(header(m.payload,'date'))||Date.now()).toISOString();
    return {id:m.id,from:from.email,fromName:from.name,to:addresses(header(m.payload,'to')),cc:addresses(header(m.payload,'cc')),date,text,html:html||undefined,sent:m.labelIds?.includes('SENT')??false,attachments:parts.filter(p=>p.filename||p.body?.attachmentId).map((p,i)=>({id:`${m.id}:${p.partId??i}`,name:p.filename||'attachment',type:p.mimeType||'application/octet-stream',size:p.body?.size??0,data:p.body?.data?Buffer.from(p.body.data,'base64url').toString('base64'):undefined,gmailAttachmentId:p.body?.attachmentId,messageId:m.id,contentId:header(p,'content-id').replace(/^<|>$/g,'')||undefined}))};
  }).sort((a,b)=>a.date.localeCompare(b.date));
  const labels=[...new Set(items.flatMap(m=>m.labelIds??[]))];
  return {id:`${account.id}:${raw.id}`,gmailId:raw.id,accountId:account.id,subject:header(items[0]?.payload,'subject')||'(No subject)',summary:htmlText(items.at(-1)?.snippet??'')||messages.at(-1)?.text.slice(0,200)||'',messages,date:messages.at(-1)?.date??new Date().toISOString(),unread:labels.includes('UNREAD'),status:labels.includes('TRASH')?'trash':labels.includes('SPAM')?'spam':labels.includes('INBOX')?'new':'done',importance:labels.includes('IMPORTANT')?'important':'low',bookmarked:labels.includes('STARRED'),replyStatus:'none',labels};
}

export async function createGoogle(options:GoogleOptions) {
  const request=options.fetch??fetch,clientId=options.clientId??process.env.GOOGLE_CLIENT_ID,clientSecret=options.clientSecret??process.env.GOOGLE_CLIENT_SECRET;
  const path=join(options.dataDir,'google-tokens.enc.json');
  const tokens:Record<string,Token>={};
  let server:Server|undefined, cancelConnect:(()=>void)|undefined;
  let persistChain=Promise.resolve();
  const refreshes=new Map<string,Promise<string>>();
  if(options.decrypt) {
    try {
      const encrypted=JSON.parse(await readFile(path,'utf8')) as Record<string,string>;
      for(const [id,value] of Object.entries(encrypted)) {
        const token=JSON.parse(options.decrypt(Buffer.from(value,'base64'))) as Token;
        if(typeof token.access_token==='string'&&typeof token.expiresAt==='number') tokens[id]=token;
      }
    } catch(error) {if((error as NodeJS.ErrnoException).code!=='ENOENT') throw new Error('Saved Google credentials could not be unlocked. Check your macOS keychain.');}
  }
  async function persist() {
    if(!options.encrypt) throw new Error('Secure credential storage is unavailable. Connect using the desktop app.');
    let snapshot:string;
    try {snapshot=JSON.stringify(Object.fromEntries(Object.entries(tokens).map(([id,value])=>[id,options.encrypt!(JSON.stringify(value)).toString('base64')])));}catch {throw new Error('Google credentials could not be encrypted. Check your macOS keychain.');}
    const operation=persistChain.then(async()=>{await mkdir(options.dataDir,{recursive:true,mode:0o700});await writeFile(`${path}.tmp`,snapshot,{mode:0o600});await rename(`${path}.tmp`,path);});
    persistChain=operation.catch(()=>{});
    try {await operation;} catch {throw new Error('Google credentials could not be saved securely. Check the data directory.');}
  }
  async function fetchJson(url:string,init:RequestInit={}):Promise<Json> {
    let response:Response;
    try {response=await request(url,{...init,signal:init.signal??AbortSignal.timeout(45000)});}catch {throw new Error('Google could not be reached. Check your internet connection.');}
    if(!response.ok) {
      if(response.status===401) throw new Error('Google authorization expired. Reconnect this account.');
      if(response.status===403) throw new Error('Google denied this operation. Enable Gmail and Calendar APIs and reconnect with the required permissions.');
      if(response.status===429) throw new Error('Google rate limit reached. Please retry shortly.');
      throw new Error(`Google request failed (${response.status}). Please retry.`);
    }
    if(response.status===204)return {};
    try{return await response.json() as Json;}catch{throw new Error('Google returned an unreadable response. Please retry.');}
  }
  async function access(id:string):Promise<string> {
    const token=tokens[id];
    if(!token) throw new Error('This Google account needs to be reconnected.');
    if(token.expiresAt>Date.now()+60000) return token.access_token;
    if(!token.refresh_token||!clientId) throw new Error('Google authorization expired. Reconnect this account.');
    const active=refreshes.get(id);if(active)return active;
    const promise=(async()=>{
      const data=await fetchJson('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:clientId,refresh_token:token.refresh_token!,grant_type:'refresh_token',...(clientSecret?{client_secret:clientSecret}:{})})});
      if(typeof data.access_token!=='string') throw new Error('Google authorization expired. Reconnect this account.');
      if(tokens[id]!==token)throw new Error('This Google account was disconnected.');
      tokens[id]={access_token:data.access_token,refresh_token:data.refresh_token??token.refresh_token,expiresAt:Date.now()+(Number(data.expires_in)||3600)*1000};await persist();return data.access_token as string;
    })();
    refreshes.set(id,promise);try{return await promise;}finally{refreshes.delete(id);}
  }
  async function api(account:Account,url:string,method='GET',body?:unknown):Promise<Json> {
    const token=await access(account.id);
    return fetchJson(url,{method,headers:{Authorization:`Bearer ${token}`,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  }
  async function pages(account:Account,url:string,key:string):Promise<Json[]> {
    const items:Json[]=[];let next:string|undefined;
    do {const pageUrl=new URL(url);if(next)pageUrl.searchParams.set('pageToken',next);const page=await api(account,pageUrl.toString());items.push(...(Array.isArray(page[key])?page[key]:[]));next=typeof page.nextPageToken==='string'?page.nextPageToken:undefined;} while(next);
    return items;
  }
  async function threads(account:Account,query?:string) {
    const url=new URL(`${gmail}/threads`);url.searchParams.set('maxResults','500');url.searchParams.set('includeSpamTrash','true');if(query)url.searchParams.set('q',query);
    const rows=await pages(account,url.toString(),'threads');const result:Thread[]=[];let cursor=0;
    await Promise.all(Array.from({length:Math.min(4,rows.length)},async()=>{while(cursor<rows.length){const row=rows[cursor++];const raw=await api(account,`${gmail}/threads/${enc(row.id)}?format=full`);result.push(normalizeGmailThread(raw as GmailThread,account));}}));
    return result.sort((a,b)=>b.date.localeCompare(a.date));
  }
  function eventModel(raw:Json,account:Account,calendarId:string):CalendarEvent {
    return {id:`${account.id}:${calendarId}:${raw.id}`,googleId:raw.id,accountId:account.id,calendarId,title:raw.summary??'(Untitled event)',start:raw.start?.dateTime??raw.start?.date??'',end:raw.end?.dateTime??raw.end?.date??'',allDay:Boolean(raw.start?.date),location:raw.location??'',description:raw.description??'',guests:(raw.attendees??[]).map((x:Json)=>x.email).filter(Boolean),url:raw.htmlLink};
  }
  async function listCalendars(account:Account) {return (await pages(account,`${calendar}/users/me/calendarList?maxResults=250`,'items')).map(item=>({id:String(item.id),name:String(item.summaryOverride??item.summary??item.id),accountId:account.id}));}
  return {
    available:Boolean(clientId),
    async connect():Promise<Account> {
      if(!clientId) throw new Error('Set GOOGLE_CLIENT_ID to your own Google Desktop OAuth client ID before connecting.');
      if(!options.encrypt||!options.decrypt) throw new Error('Secure credential storage is unavailable. Connect using the desktop app.');
      if(!options.openExternal) throw new Error('Google sign-in requires the desktop app and a system browser.');
      if(server) throw new Error('A Google sign-in is already in progress.');
      const state=randomBytes(32).toString('base64url'),verifier=randomBytes(48).toString('base64url');
      const challenge=createHash('sha256').update(verifier).digest('base64url');
      let redirect='';
      let resolveCode!:(code:string)=>void,rejectCode!:(error:Error)=>void;
      const codePromise=new Promise<string>((resolve,reject)=>{resolveCode=resolve;rejectCode=reject;});
      // Attach rejection handling before opening a browser, which may itself fail.
      void codePromise.catch(()=>{});
      const listener=createServer((req,res)=>{
        const url=new URL(req.url??'/',redirect);
        if(url.pathname!=='/oauth/callback'){res.writeHead(404);res.end();return;}
        if(url.searchParams.get('state')!==state){res.writeHead(400);res.end('Invalid sign-in state.');return;}
        res.setHeader('Content-Type','text/html; charset=utf-8');res.setHeader('Cache-Control','no-store');
        const code=url.searchParams.get('code');
        if(url.searchParams.has('error')||!code){res.end('<p>Sign-in cancelled. Return to Aplos Mail.</p>');rejectCode(new Error('Google sign-in was declined.'));return;}
        res.end('<p>Sign-in received. You can close this tab and return to Aplos Mail.</p>');resolveCode(code);
      });
      server=listener;cancelConnect=()=>rejectCode(new Error('Google sign-in cancelled.'));
      let timer:ReturnType<typeof setTimeout>|undefined;
      try {
        await new Promise<void>((resolve,reject)=>{listener.once('error',reject);listener.listen(0,'127.0.0.1',()=>resolve());});
        const address=listener.address();if(!address||typeof address==='string')throw new Error('Google sign-in could not open its local callback.');
        redirect=`http://127.0.0.1:${address.port}/oauth/callback`;
        timer=setTimeout(()=>rejectCode(new Error('Google sign-in timed out. Please try again.')),options.oauthTimeoutMs??180000);
        const auth=new URL('https://accounts.google.com/o/oauth2/v2/auth');
        const params={client_id:clientId,redirect_uri:redirect,response_type:'code',scope:'openid email profile https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events',state,code_challenge:challenge,code_challenge_method:'S256',access_type:'offline',prompt:'consent'};
        auth.search=new URLSearchParams(params).toString();await options.openExternal(auth.toString());
        const code=await codePromise;
        const result=await fetchJson('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({code,client_id:clientId,redirect_uri:redirect,grant_type:'authorization_code',code_verifier:verifier,...(clientSecret?{client_secret:clientSecret}:{})})});
        if(typeof result.access_token!=='string')throw new Error('Google sign-in did not return access credentials.');
        const profile=await fetchJson('https://www.googleapis.com/oauth2/v3/userinfo',{headers:{Authorization:`Bearer ${result.access_token}`}});
        if(typeof profile.email!=='string'||typeof profile.sub!=='string')throw new Error('Google did not return an account identity.');
        const id=`google-${profile.sub}`;
        tokens[id]={access_token:result.access_token,refresh_token:result.refresh_token??tokens[id]?.refresh_token,expiresAt:Date.now()+(Number(result.expires_in)||3600)*1000};
        try{await persist();}catch(error){delete tokens[id];throw error;}
        return {id,name:profile.name??profile.email,email:profile.email,provider:'google',color:'#738c80',connected:true,calendarConnected:true};
      } finally {if(timer)clearTimeout(timer);listener.close();server=undefined;cancelConnect=undefined;}
    },
    async disconnect(accountId:string) {
      const token=tokens[accountId];delete tokens[accountId];await persist();
      if(token) {try{await request('https://oauth2.googleapis.com/revoke',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token:token.refresh_token??token.access_token}),signal:AbortSignal.timeout(10000)});}catch{/* Local disconnect remains effective while offline. */}}
    },
    sync:(account:Account)=>threads(account),
    search:(account:Account,query:string)=>threads(account,query),
    async updateThread(account:Account,thread:Thread,patch:Partial<Thread>) {
      if(!thread.gmailId) throw new Error('This thread has no Gmail identifier.');
      const url=`${gmail}/threads/${enc(thread.gmailId)}`;
      if(patch.status==='trash') await api(account,`${url}/trash`,'POST',{});
      if(thread.status==='trash'&&patch.status&&patch.status!=='trash')await api(account,`${url}/untrash`,'POST',{});
      const addLabelIds:string[]=[],removeLabelIds:string[]=[];
      const label=(value:boolean,name:string)=>(value?addLabelIds:removeLabelIds).push(name);
      if(patch.unread!==undefined)label(patch.unread,'UNREAD');
      if(patch.bookmarked!==undefined)label(patch.bookmarked,'STARRED');
      if(patch.importance!==undefined)label(patch.importance==='important','IMPORTANT');
      if(patch.status){label(patch.labels?patch.labels.includes('INBOX'):patch.status==='new','INBOX');label(patch.status==='spam','SPAM');}
      if(addLabelIds.length||removeLabelIds.length)await api(account,`${url}/modify`,'POST',{addLabelIds,removeLabelIds});
    },
    async send(account:Account,draft:Draft) {
      if(!draft.to.trim())throw new Error('Add at least one recipient before sending.');
      for(const value of [draft.to,draft.cc,draft.bcc,draft.subject,account.email])if(/[\r\n]/.test(value))throw new Error('Email headers cannot contain line breaks.');
      let gmailId:string|undefined,inReplyTo:string|undefined,references:string|undefined;
      if(draft.threadId&&draft.mode!=='new'&&draft.mode!=='forward'){
        gmailId=draft.threadId.startsWith(`${account.id}:`)?draft.threadId.slice(account.id.length+1):undefined;
        if(gmailId){const raw=await api(account,`${gmail}/threads/${enc(gmailId)}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=References`);const payload=raw.messages?.at(-1)?.payload as GmailPart|undefined;inReplyTo=header(payload,'message-id')||undefined;references=[header(payload,'references'),inReplyTo].filter(Boolean).join(' ')||undefined;}
      }
      const transport=nodemailer.createTransport({streamTransport:true,buffer:true,newline:'windows'});
      const info=await transport.sendMail({from:{name:account.name,address:account.email},to:draft.to,cc:draft.cc||undefined,bcc:draft.bcc||undefined,subject:draft.subject,html:draft.html,text:htmlText(draft.html),inReplyTo,references,attachments:draft.attachments.map(a=>{if(!a.data)throw new Error(`Attachment "${a.name}" has not been downloaded. Reattach it before sending.`);return {filename:a.name,content:Buffer.from(a.data,'base64'),contentType:a.type,cid:a.contentId};}),disableFileAccess:true,disableUrlAccess:true});
      if(!Buffer.isBuffer(info.message))throw new Error('Email could not be encoded for Gmail.');
      const raw=info.message;
      return api(account,`${gmail}/messages/send`,'POST',{raw:raw.toString('base64url'),...(gmailId?{threadId:gmailId}:{})});
    },
    async attachment(account:Account,_thread:Thread,attachment:Attachment):Promise<Attachment> {
      if(attachment.data)return attachment;
      if(!attachment.gmailAttachmentId||!attachment.messageId)throw new Error('This attachment has no downloadable content.');
      const raw=await api(account,`${gmail}/messages/${enc(attachment.messageId)}/attachments/${enc(attachment.gmailAttachmentId)}`);
      if(typeof raw.data!=='string')throw new Error('Google returned an empty attachment.');
      return {...attachment,data:Buffer.from(raw.data,'base64url').toString('base64')};
    },
    listCalendars,
    async listEvents(account:Account):Promise<CalendarEvent[]> {
      const calendars=await listCalendars(account);const result:CalendarEvent[]=[];
      const min=new Date();min.setDate(min.getDate()-30);const max=new Date();max.setFullYear(max.getFullYear()+1);
      for(const c of calendars){const params=new URLSearchParams({singleEvents:'true',orderBy:'startTime',maxResults:'2500',timeMin:min.toISOString(),timeMax:max.toISOString()});const rows=await pages(account,`${calendar}/calendars/${enc(c.id)}/events?${params}`,'items');result.push(...rows.filter(row=>row.status!=='cancelled').map(row=>eventModel(row,account,c.id)));}
      return result;
    },
    async saveEvent(account:Account,event:CalendarEvent):Promise<CalendarEvent> {
      if(!event.title.trim()||!Number.isFinite(Date.parse(event.start))||!Number.isFinite(Date.parse(event.end))||Date.parse(event.end)<=Date.parse(event.start))throw new Error('A calendar event needs a title and valid start and end times.');
      const path=`${calendar}/calendars/${enc(event.calendarId||'primary')}/events${event.googleId?`/${enc(event.googleId)}`:''}`;
      const raw=await api(account,`${path}?sendUpdates=none`,event.googleId?'PUT':'POST',{summary:event.title,description:event.description,location:event.location,start:event.allDay?{date:event.start.slice(0,10)}:{dateTime:new Date(event.start).toISOString()},end:event.allDay?{date:event.end.slice(0,10)}:{dateTime:new Date(event.end).toISOString()},attendees:event.guests.map(email=>({email}))});
      return {...event,...eventModel(raw,account,event.calendarId||'primary'),id:event.id};
    },
    async deleteEvent(account:Account,event:CalendarEvent) {if(!event.googleId)throw new Error('This event has no Google identifier.');await api(account,`${calendar}/calendars/${enc(event.calendarId)}/events/${enc(event.googleId)}?sendUpdates=none`,'DELETE');},
    close(){cancelConnect?.();server?.close();}
  };
}
export type GoogleAdapter = Awaited<ReturnType<typeof createGoogle>>;
