import {useEffect,useRef,useState} from 'react';
import {ArrowUpRight, Bold, Check, ChevronDown, Italic, Link, Loader2, Mic, Paperclip, Send, Sparkles, Trash2, Underline, X, ImageIcon, Square} from './icons';
import DOMPurify from 'dompurify';
import type {Account,Draft,Settings,Thread} from '../shared/types';
import {bridge,escapeHtml,fileToAttachment,invoke,plain,uid} from './bridge';
import {useVoice} from './useVoice';
interface Props {draft:Draft;accounts:Account[];settings:Settings;thread?:Thread;close:()=>void;notify:(text:string)=>void;popout?:boolean;onChange?:(draft:Draft)=>void}
function keepImages(previous:string,next:string){
  const oldDocument=new DOMParser().parseFromString(previous,'text/html');
  const nextDocument=new DOMParser().parseFromString(DOMPurify.sanitize(next),'text/html');
  const sources=new Set(Array.from(nextDocument.images).map(image=>image.getAttribute('src')));
  for(const image of Array.from(oldDocument.images)){const source=image.getAttribute('src');if(source&&!sources.has(source)){const paragraph=nextDocument.createElement('p');paragraph.append(nextDocument.importNode(image,true));nextDocument.body.append(paragraph);sources.add(source);}}
  return DOMPurify.sanitize(nextDocument.body.innerHTML);
}
export function Compose({draft,accounts,settings,thread,close,notify,popout,onChange}:Props){
  const [form,setForm]=useState<Draft>(draft);const current=useRef(form);const editor=useRef<HTMLDivElement>(null);const file=useRef<HTMLInputElement>(null);const inline=useRef<HTMLInputElement>(null);
  const [expanded,setExpanded]=useState(!!(draft.cc||draft.bcc));const [saved,setSaved]=useState(true);const [busy,setBusy]=useState('');const [error,setError]=useState(draft.sendError||'');const [prompt,setPrompt]=useState('');const [showAI,setShowAI]=useState(false);
  const mounted=useRef(true);const dirty=useRef(false);const edits=useRef(0);const saving=useRef<Promise<Draft>>(Promise.resolve(draft));const operation=useRef('');const workVersion=useRef(0);const aiRequest=useRef<string|undefined>(undefined);const terminal=useRef(false);const lastProp=useRef(draft);const terminalJob=useRef<Promise<void>|undefined>(undefined);
  const signatureOn=form.signature&&settings.signatureMode!=='never'&&(settings.signatureMode==='always'||['new','forward'].includes(form.mode));
  const sendingAccount=accounts.find(account=>account.id===form.accountId);
  const fromEmail=form.fromEmail||sendingAccount?.email||'';
  const sendingAlias=sendingAccount?.sendAs?.find(alias=>alias.email.toLowerCase()===fromEmail.toLowerCase());
  const signatureSource=form.signatureSource??'custom';
  const gmailSignature=signatureSource==='gmail'?sendingAlias?.signature||'':'';
  const lockAccount=form.mode!=='new'||!!form.threadId;
  function senders(account:Account){const aliases=account.sendAs??[];return aliases.some(alias=>alias.email.toLowerCase()===account.email.toLowerCase())?aliases:[{email:account.email,name:account.name,signature:'',isDefault:!aliases.some(alias=>alias.isDefault)},...aliases];}
  const senderAvailable=Boolean(sendingAccount&&senders(sendingAccount).some(alias=>alias.email.toLowerCase()===fromEmail.toLowerCase()));
  function changeSender(value:string){
    const [accountId,email]=JSON.parse(value) as [string,string];
    const account=accounts.find(account=>account.id===accountId);if(!account||!account.connected||(lockAccount&&account.id!==form.accountId))return;
    const alias=senders(account).find(alias=>alias.email===email);if(!alias)return;
    patch({accountId:account.id,fromEmail:alias.email,signatureSource:account.provider==='google'?signatureSource:'custom'});
  }

  function update(next:Draft){current.current=next;if(mounted.current){setForm(next);onChange?.(next);}}
  function patch(value:Partial<Draft>,internal=false){
    if(terminal.current||(!internal&&operation.current))return;
    dirty.current=true;edits.current++;setSaved(false);setError('');
    update({...current.current,...value,updatedAt:new Date().toISOString()});
  }
  function working(name:string){operation.current=name;if(mounted.current)setBusy(name);}
  function stopWork(){workVersion.current++;voice.cancel();if(aiRequest.current)void invoke('ai.cancel',{requestId:aiRequest.current}).catch(()=>{});aiRequest.current=undefined;}
  useEffect(()=>{if(editor.current)editor.current.innerHTML=DOMPurify.sanitize(draft.html);},[draft.id]);
  useEffect(()=>{
    if(lastProp.current===draft)return;lastProp.current=draft;if(terminal.current)return;
    stopWork();working('');
    const next={...current.current,...draft,html:keepImages(current.current.html,draft.html),revision:Math.max(current.current.revision,draft.revision)};
    if(editor.current)editor.current.innerHTML=next.html;
    patch(next,true);setExpanded(Boolean(next.cc||next.bcc));
  },[draft]);
  async function save():Promise<Draft>{
    const job=saving.current.catch(()=>current.current).then(async()=>{
      if(!dirty.current)return current.current;
      const version=edits.current;
      const snapshot={...current.current,html:editor.current?.innerHTML??current.current.html};
      const result=await invoke<Draft>('draft.save',{draft:snapshot});
      update({...current.current,revision:result.revision});
      if(edits.current===version){dirty.current=false;if(mounted.current)setSaved(true);}
      return result;
    });
    saving.current=job;return job;
  }
  useEffect(()=>{if(!dirty.current||terminal.current)return;const timer=setTimeout(()=>{if(!terminal.current)void save().catch(error=>{if(mounted.current)setError(error.message);});},650);return()=>clearTimeout(timer);},[form]);
  useEffect(()=>{const unload=(event:BeforeUnloadEvent)=>{if(dirty.current&&!window.aplos){event.preventDefault();event.returnValue='';}};window.addEventListener('beforeunload',unload);return()=>window.removeEventListener('beforeunload',unload);},[]);
  async function finish(kind:'close'|'send'|'popout'|'discard'|'native-close'){
    if(terminal.current){if(kind==='native-close'){await terminalJob.current;await invoke(terminal.current?'window.closeReady':'window.closeCancel');}return;}
    if(kind==='send'&&(operation.current||voice.isActive())){setError('Finish the current recording or operation before sending.');return;}
    terminal.current=true;stopWork();working(kind);setError('');
    const job=(async()=>{
      try{
        if(kind==='discard'){
          await saving.current.catch(()=>{});await invoke('draft.delete',{id:current.current.id});dirty.current=false;close();notify('Draft discarded');
        }else{
          if(kind==='send'&&!current.current.to.trim())throw new Error('Add at least one recipient.');
          await save();
          if(kind==='send'){
            await invoke('draft.send',{id:current.current.id});notify(settings.undoSeconds?`Sending in ${settings.undoSeconds} seconds. You can undo from the inbox.`:'Message queued');close();
          }else if(kind==='popout'){await invoke('window.compose',{draftId:current.current.id});close();}
          else if(kind==='native-close')await invoke('window.closeReady');
          else close();
        }
      }catch(error){
        terminal.current=false;working('');if(mounted.current)setError((error as Error).message);
        if(kind==='native-close')await invoke('window.closeCancel').catch(()=>{});
      }
    })();terminalJob.current=job;await job;
  }
  const closeHandler=useRef(()=>finish('native-close'));closeHandler.current=()=>finish('native-close');
  useEffect(()=>bridge.subscribe(event=>{if(event.type==='prepare-close')void closeHandler.current();}),[]);
  useEffect(()=>{mounted.current=true;terminal.current=false;return()=>{mounted.current=false;terminal.current=true;stopWork();};},[]);
  useEffect(()=>{function keyboard(event:KeyboardEvent){if(event.defaultPrevented||(event.target as HTMLElement)?.closest?.('.ask-panel'))return;if((event.metaKey||event.ctrlKey)&&event.key==='Enter'){event.preventDefault();event.stopPropagation();void finish('send');}if(event.key==='Escape'){event.stopPropagation();void finish('close');}}window.addEventListener('keydown',keyboard);return()=>window.removeEventListener('keydown',keyboard);});
  function setBody(html:string,preserveImages=false){const safe=preserveImages?keepImages(current.current.html,html):DOMPurify.sanitize(html);if(editor.current)editor.current.innerHTML=safe;patch({html:safe},true);}
  function applyProposal(proposal:Partial<Draft>){
    const fields:Partial<Draft>={};for(const key of ['to','cc','bcc','subject'] as const)if(typeof proposal[key]==='string'&&proposal[key]!.trim())fields[key]=proposal[key];
    if(proposal.html!==undefined)setBody(proposal.html,true);
    patch(fields,true);if(fields.cc||fields.bcc)setExpanded(true);
  }
  async function ai(kind:'polish'|'draft',instruction=prompt){
    if(operation.current||terminal.current||voice.isActive())return;
    const version=++workVersion.current;const requestId=uid();aiRequest.current=requestId;setError('');working(kind);
    try{
      const snapshot={...current.current,html:editor.current?.innerHTML??current.current.html};
      if(kind==='polish'){
        const result=await invoke<{html:string}>('ai.polish',{html:snapshot.html,instruction,requestId});if(workVersion.current!==version||terminal.current)return;setBody(result.html,true);
      }else{
        const result=await invoke<Partial<Draft>>('ai.draft',{instruction,threadId:thread?.id,draft:snapshot,requestId});if(workVersion.current!==version||terminal.current)return;applyProposal(result);
      }
      setShowAI(false);setPrompt('');
    }catch(error){if(workVersion.current===version&&mounted.current)setError((error as Error).message);}
    finally{if(workVersion.current===version){aiRequest.current=undefined;working('');}}
  }
  const voice=useVoice(settings.microphone,async text=>{
    if(terminal.current||!text.trim())return;
    if(showAI){setPrompt(text);return;}
    const version=++workVersion.current;const html=`<p>${escapeHtml(text.trim()).replace(/\n/g,'<br>')}</p>`;const previous=editor.current?.innerHTML??current.current.html;
    // Persist the transcript immediately so closing during polish cannot discard it.
    setBody(previous+html);
    try{
      if(settings.autoPolish){const requestId=uid();aiRequest.current=requestId;working('polish');const result=await invoke<{html:string}>('ai.polish',{html,instruction:'Proofread this dictated email text. Preserve its meaning and do not add a greeting or signature.',requestId});if(workVersion.current!==version||terminal.current)return;setBody(previous+DOMPurify.sanitize(result.html));}
    }catch(error){if(workVersion.current===version&&!terminal.current)setError(`Dictation was inserted without polish: ${(error as Error).message}`);}
    finally{if(workVersion.current===version){aiRequest.current=undefined;working('');}}
  },setError);
  async function attach(files:FileList|null,asImage=false){
    if(!files||operation.current||terminal.current)return;
    const version=++workVersion.current;working('attach');
    try{for(const item of Array.from(files)){
      if(item.size>20*1024*1024)throw new Error('Each attachment must be under 20 MB.');
      const attachment=await fileToAttachment(item);if(workVersion.current!==version||terminal.current)return;
      if(asImage){if(!attachment.type.startsWith('image/'))throw new Error('Choose an image file.');setBody((editor.current?.innerHTML??current.current.html)+`<p><img src="data:${attachment.type};base64,${attachment.data}" alt="${escapeHtml(attachment.name)}" style="max-width:100%"></p>`);}
      else{if(current.current.attachments.reduce((total,item)=>total+item.size,attachment.size)>25*1024*1024)throw new Error('Attachments must total less than 25 MB.');patch({attachments:[...current.current.attachments,attachment]},true);}
    }}catch(error){if(workVersion.current===version)setError((error as Error).message);}
    finally{if(workVersion.current===version)working('');}
  }
  function format(command:string){if(operation.current||terminal.current)return;editor.current?.focus();document.execCommand(command);patch({html:editor.current?.innerHTML??''});}
  const [link,setLink]=useState('');const [showLink,setShowLink]=useState(false);
  const sendDisabled=!!busy||voice.recording||voice.busy;
  return <div className={popout?'compose-popout':'compose-layer'} onMouseDown={e=>{if(e.target===e.currentTarget&&!popout)void finish('close');}}><section className="composer" role="dialog" aria-modal="true" aria-label="Compose email">
    <header className="compose-header"><div className="title-with-icon"><strong>{form.mode==='new'?'New email':form.mode==='forward'?'Forward':form.mode==='reply-all'?'Reply all':'Reply'}</strong><span className="save-status">{saved?<><Check size={12}/>Saved</>:<><Loader2 size={12} className="spin"/>Saving</>}</span></div><div className="actions">{!popout&&<button className="icon-button" title="Open in separate window" aria-label="Open in separate window" onClick={()=>void finish('popout')} disabled={!!busy}><ArrowUpRight size={18}/></button>}<button className="icon-button" title="Discard draft" aria-label="Discard draft" onClick={async()=>{if(confirm('Discard this draft?'))await finish('discard');}}><Trash2 size={17}/></button>{popout&&<button className="icon-button" title="Close (Esc)" aria-label="Close composer" onClick={()=>void finish('close')}><X size={18}/></button>}<button className={'send-button '+(form.to.trim()?'ready':'')} title="Send (⌘ ↵)" onClick={()=>void finish('send')} disabled={sendDisabled}>{busy==='send'?<Loader2 size={15} className="spin"/>:<Send size={15}/>}Send</button></div></header>
    <div className="compose-fields"><div className="field-line"><label htmlFor="compose-from">From</label><select id="compose-from" value={JSON.stringify([form.accountId,fromEmail])} disabled={!!busy} onChange={event=>changeSender(event.target.value)}>{!senderAvailable&&<option value={JSON.stringify([form.accountId,fromEmail])} disabled>Unavailable address: {fromEmail}</option>}{accounts.map(account=><optgroup key={account.id} label={account.name+' · '+account.email} disabled={!account.connected||(lockAccount&&account.id!==form.accountId)}>{senders(account).map(alias=><option value={JSON.stringify([account.id,alias.email])} key={alias.email}>{alias.name||account.name} &lt;{alias.email}&gt;{alias.isDefault?' (default)':''}</option>)}</optgroup>)}</select><ChevronDown size={13}/></div><div className="field-line"><label htmlFor="compose-to">To</label><input id="compose-to" autoFocus={!form.to} value={form.to} disabled={!!busy} placeholder="name@example.com" onChange={e=>patch({to:e.target.value})}/><button className="text-button muted" onClick={()=>setExpanded(!expanded)}>{expanded?'Hide':'Cc / Bcc'}</button></div>{expanded&&<><div className="field-line"><label htmlFor="compose-cc">Cc</label><input id="compose-cc" value={form.cc} disabled={!!busy} onChange={e=>patch({cc:e.target.value})}/></div><div className="field-line"><label htmlFor="compose-bcc">Bcc</label><input id="compose-bcc" value={form.bcc} disabled={!!busy} onChange={e=>patch({bcc:e.target.value})}/></div></>}<div className="field-line"><label htmlFor="compose-subject">Subject</label><input id="compose-subject" value={form.subject} disabled={!!busy} onChange={e=>patch({subject:e.target.value})} placeholder="A little context…"/></div></div>
    <div className="compose-body"><div ref={editor} className="rich-editor" contentEditable={!busy} suppressContentEditableWarning role="textbox" aria-label="Message body" aria-multiline="true" data-placeholder="Write something thoughtful…" onInput={()=>patch({html:editor.current?.innerHTML??''})} onPaste={e=>{e.preventDefault();const html=e.clipboardData.getData('text/html');document.execCommand('insertHTML',false,html?DOMPurify.sanitize(html):escapeHtml(e.clipboardData.getData('text/plain')).replace(/\n/g,'<br>'));patch({html:editor.current?.innerHTML??''});}}/>{signatureOn&&(signatureSource==='gmail'?gmailSignature?<div className="signature-preview" dangerouslySetInnerHTML={{__html:DOMPurify.sanitize(gmailSignature)}}/>:<p className="small muted">{sendingAccount?.sendAs?'No Gmail signature is set for this sending address.':'Gmail signatures are unavailable. Sync or reconnect this account.'}</p>:settings.signature&&<div className="signature-preview">{settings.signature}</div>)}{settings.footer&&<p className="muted small">Sent with Aplos Mail</p>}</div>
    {form.attachments.length>0&&<div className="compose-attachments">{form.attachments.map(a=><span className="attachment" key={a.id}><Paperclip size={13}/>{a.name}<span className="muted small">{Math.ceil(a.size/1024)} KB</span><button className="icon-button tiny" aria-label={'Remove '+a.name} onClick={()=>patch({attachments:form.attachments.filter(x=>x.id!==a.id)})}><X size={13}/></button></span>)}</div>}
    {sendingAccount?.error&&<p className="small muted" role="status" style={{padding:'0 22px 8px'}}>{sendingAccount.error}</p>}
    {error&&<div className="inline-error" role="alert">{error}</div>}
    {(busy==='polish'||busy==='draft')&&<div className="compose-ai"><Loader2 size={15} className="spin"/><span>{busy==='polish'?'Polishing…':'Writing…'}</span><button onClick={()=>{stopWork();working('');}}>Cancel</button></div>}
    {(showAI||voice.recording||voice.busy)&&<div className="compose-ai"><Sparkles size={17}/><input aria-label="AI writing instructions" value={prompt} onChange={e=>setPrompt(e.target.value)} placeholder={voice.recording?'Listening…':'Describe what you want to write or change…'} onKeyDown={e=>{if(e.key==='Enter'&&prompt.trim())void ai('draft');}}/>{voice.recording?<><span className="recording-dot"/><button onClick={voice.stop}>Finish</button><button onClick={voice.cancel}>Cancel</button></>:<button disabled={!prompt.trim()||!!busy||voice.busy} onClick={()=>void ai('draft')}>{busy==='draft'||voice.busy?<Loader2 size={15} className="spin"/>:'Write'}</button>}</div>}
    {showLink&&<div className="link-editor"><input aria-label="Link URL" placeholder="https://…" value={link} onChange={e=>setLink(e.target.value)}/><button onClick={()=>{if(!/^https?:\/\//i.test(link)){setError('Use a full https:// link.');return;}editor.current?.focus();document.execCommand('createLink',false,link);patch({html:editor.current?.innerHTML??''});setShowLink(false);setLink('');}}>Insert link</button><button onClick={()=>setShowLink(false)}>Cancel</button></div>}
    <footer className="compose-footer"><div className="actions"><button className="text-button attach-button" title="Attach files" onClick={()=>file.current?.click()}><Paperclip size={15}/>Attach</button><span className="separator"/><button title="Bold" aria-label="Bold" className="icon-button" onMouseDown={e=>e.preventDefault()} onClick={()=>format('bold')}><Bold size={15}/></button><button title="Italic" aria-label="Italic" className="icon-button" onMouseDown={e=>e.preventDefault()} onClick={()=>format('italic')}><Italic size={15}/></button><button title="Underline" aria-label="Underline" className="icon-button" onMouseDown={e=>e.preventDefault()} onClick={()=>format('underline')}><Underline size={15}/></button><button title="Insert link" aria-label="Insert link" className="icon-button" onMouseDown={e=>e.preventDefault()} onClick={()=>setShowLink(!showLink)}><Link size={15}/></button><button title="Insert inline image" aria-label="Insert inline image" className="icon-button" onClick={()=>inline.current?.click()}><ImageIcon size={15}/></button></div><div className="actions"><label className="signature-toggle"><input type="checkbox" checked={form.signature} disabled={!!busy} onChange={e=>patch({signature:e.target.checked})}/>Signature</label>{sendingAccount?.provider==='google'&&<select className="signature-source" aria-label="Signature source" value={signatureSource} disabled={!!busy} onChange={event=>patch({signatureSource:event.target.value as 'custom'|'gmail'})}><option value="custom">Custom</option><option value="gmail">Gmail</option></select>}<span className="separator"/><button className="text-button" title="Polish with Groq" disabled={!!busy||!plain(form.html).trim()} onClick={()=>void ai('polish')}><Sparkles size={15}/>{busy==='polish'?'Polishing…':'Polish'}</button><button className={'icon-button '+(showAI?'active':'')} title="Write with AI" aria-label="Write with AI" onClick={()=>setShowAI(!showAI)}><Sparkles size={16}/></button><button className={'icon-button '+(voice.recording?'recording':'')} title={showAI?"Dictate instructions":"Dictate message"} aria-label={showAI?"Dictate instructions":"Dictate message"} disabled={voice.busy||!!busy} onClick={voice.toggle}>{voice.recording?<Square size={15}/>:voice.busy?<Loader2 size={15} className="spin"/>:<Mic size={16}/>}</button></div></footer>
    <input type="file" ref={file} hidden multiple onChange={e=>{void attach(e.target.files);e.target.value='';}}/><input type="file" ref={inline} hidden accept="image/*" onChange={e=>{void attach(e.target.files,true);e.target.value='';}}/>
  </section>{!popout&&<p className="compose-hint"><kbd>⌘ ↵</kbd> to send<span>·</span><kbd>Esc</kbd> to close</p>}</div>;
}
