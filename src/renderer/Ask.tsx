import {useEffect,useRef,useState} from 'react';
import {ArrowUp,Clock,History,Loader2,Mic,Plus,Sparkles,Square,Trash2,X,ExternalLink,StopCircle} from 'lucide-react';
import type {Account,Conversation,Draft,Settings,Thread} from '../shared/types';
import {invoke,uid} from './bridge';
import {useVoice} from './useVoice';
export function Ask({conversations,threads,accountId,settings,close,onThread,onDraft,notify,currentDraft,onApplyDraft}:{conversations:Conversation[];threads:Thread[];accountId:string;settings:Settings;close:()=>void;onThread:(id:string)=>void;onDraft:(draft:Partial<Draft>)=>void;notify:(t:string)=>void;currentDraft?:Draft;onApplyDraft?:(proposal:Partial<Draft>)=>void}){
  const [id,setId]=useState<string|undefined>();const [input,setInput]=useState('');const [busy,setBusy]=useState(false);const [history,setHistory]=useState(false);const [error,setError]=useState('');const [pending,setPending]=useState('');
  const end=useRef<HTMLDivElement>(null);const panel=useRef<HTMLElement>(null);const conversation=conversations.find(c=>c.id===id);
  const mounted=useRef(true);const request=useRef<string|undefined>(undefined);const held=useRef(false);const snapshots=useRef(new Map<string,string>());
  function fingerprint(draft?:Draft){return draft?JSON.stringify([draft.id,draft.to,draft.cc,draft.bcc,draft.subject,draft.html,draft.attachments.map(a=>a.id)]):'';}
  useEffect(()=>{end.current?.scrollIntoView({behavior:'smooth'});},[conversation?.messages.length,busy]);
  async function ask(text=input){
    if(!text.trim()||request.current||voice.isActive())return;
    const requestId=uid();request.current=requestId;const snapshot=fingerprint(currentDraft);
    setBusy(true);setError('');setPending(text);setInput('');
    try{
      const result=await invoke<Conversation>('ai.ask',{conversationId:id,message:text,accountId,draft:currentDraft,requestId});
      if(!mounted.current||request.current!==requestId)return;
      snapshots.current.set(`${result.id}:${result.messages.length-1}`,snapshot);setId(result.id);
    }catch(error){if(mounted.current&&request.current===requestId){setError((error as Error).message);setInput(text);}}
    finally{if(mounted.current&&request.current===requestId){request.current=undefined;setBusy(false);setPending('');}}
  }
  function cancelRequest(){const requestId=request.current;if(requestId)void invoke('ai.cancel',{requestId}).catch(error=>{if(mounted.current)setError(error.message);});}
  function dismiss(){voice.cancel();cancelRequest();close();}
  function apply(proposal:Partial<Draft>,index:number){
    const fields:Partial<Draft>={};
    for(const key of ['to','cc','bcc','subject','html'] as const){const value=proposal[key];if(typeof value==='string'&&(key==='html'||value.trim()))fields[key]=value;}
    if(currentDraft){
      if(!onApplyDraft){setError('Close the current draft before opening another proposal.');return;}
      const snapshot=snapshots.current.get(`${id}:${index}`);
      if(snapshot!==fingerprint(currentDraft)&&!window.confirm('This draft changed since this suggestion was written. Apply the suggestion to the current draft?'))return;
      onApplyDraft(fields);notify('Suggestion applied. Review the draft before sending.');
    }else onDraft(fields);
  }
  const voice=useVoice(settings.microphone,text=>{setInput(text);},setError);
  useEffect(()=>{
    const down=(event:KeyboardEvent)=>{
      const target=event.target as HTMLElement;
      if(event.code!=='KeyA'||event.repeat||event.metaKey||event.ctrlKey||event.altKey||request.current||['INPUT','TEXTAREA','SELECT'].includes(target.tagName)||target.isContentEditable)return;
      if(currentDraft&&!panel.current?.contains(target))return;
      event.preventDefault();held.current=true;void voice.start();
    };
    const release=()=>{if(held.current){held.current=false;voice.stop();}};
    const up=(event:KeyboardEvent)=>{if(event.code==='KeyA')release();};
    window.addEventListener('keydown',down);window.addEventListener('keyup',up);window.addEventListener('blur',release);
    return()=>{window.removeEventListener('keydown',down);window.removeEventListener('keyup',up);window.removeEventListener('blur',release);};
  });
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;cancelRequest();};},[]);
  return <aside ref={panel} className="ask-panel" aria-label="Ask Aplos" onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();dismiss();}}}><header><div className="title-with-icon"><span className="ai-symbol"><Sparkles size={17}/></span><strong>Ask Aplos</strong></div><div className="actions"><button className="icon-button" title="Conversation history" disabled={busy} onClick={()=>setHistory(!history)}><History size={17}/></button><button className="icon-button" title="New conversation" disabled={busy} onClick={()=>{setId(undefined);setHistory(false);setError('');}}><Plus size={18}/></button><button className="icon-button" aria-label="Close Ask" onClick={dismiss}><X size={18}/></button></div></header>
    {history?<div className="ask-history"><p className="eyebrow">Your conversations</p>{conversations.length===0&&<p className="muted">A fresh start. Ask your first question.</p>}{[...conversations].reverse().map(c=><div className="history-row" key={c.id}><button onClick={()=>{setId(c.id);setHistory(false);}}><Clock size={14}/><span>{c.title}</span></button><button className="icon-button" title="Delete conversation" disabled={busy} onClick={()=>{void invoke('conversation.delete',{id:c.id}).then(()=>{if(id===c.id)setId(undefined);}).catch(e=>notify(e.message));}}><Trash2 size={14}/></button></div>)}</div>:<div className="ask-scroll">{!conversation&&!busy?<div className="ask-welcome"><span className="large-sparkle"><Sparkles size={26}/></span><h2>A little help,<br/>a little headspace.</h2><p>Find the details, connect the dots,<br/>or get a first draft going.</p><div className="ask-suggestions">{['What needs my attention today?','What plans are coming up?','Draft a friendly follow-up'].map(q=><button key={q} onClick={()=>void ask(q)}>{q}<ArrowUp size={14}/></button>)}</div><p className="small muted">Answers are grounded in the selected mailbox.<br/>Powered by Groq.</p></div>:<>{conversation?.messages.map((m,i)=><div key={i} className={'chat-message '+m.role}>{m.role==='assistant'&&<span className="assistant-label"><Sparkles size={12}/> Aplos</span>}<div className="chat-text">{m.content}</div>{!!m.citations?.length&&<div className="citations">{m.citations.map(cid=>{const t=threads.find(t=>t.id===cid);return t&&<button key={cid} onClick={()=>onThread(cid)}><ExternalLink size={12}/>{t.subject}</button>;})}</div>}{m.proposal&&<div className="proposal"><p className="eyebrow">Suggested draft</p><strong>{m.proposal.subject||'New message'}</strong><p>{m.proposal.to}</p><button className="secondary" onClick={()=>apply(m.proposal!,i)}>{currentDraft?'Apply to open draft':'Open as a draft'} <ExternalLink size={13}/></button></div>}</div>)}{busy&&<><div className="chat-message user">{pending}</div><div className="thinking"><span/><span/><span/> Looking through your mail</div></>}<div ref={end}/></>}</div>}
    <div className="ask-bottom">{error&&<div className="inline-error" role="alert">{error}</div>}{voice.recording&&<div className="voice-status"><span className="recording-dot"/> Listening <button onClick={voice.cancel}>Cancel</button></div>}<div className="ask-input"><textarea aria-label="Ask your mailbox" placeholder={voice.recording?'Listening…':'Ask anything about your mail…'} value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();void ask();}}} rows={2}/><div className="ask-input-footer"><span>{voice.preparing?'Preparing microphone…':voice.busy?'Transcribing…':voice.recording?'Release A or finish recording':'Hold A to talk'}</span><div className="actions"><button className={'icon-button '+(voice.recording?'recording':'')} title={voice.recording?'Finish recording':'Record question'} disabled={voice.busy||busy} onClick={voice.toggle}>{voice.busy?<Loader2 size={16} className="spin"/>:voice.recording?<Square size={16}/>:<Mic size={17}/>}</button>{busy?<button className="icon-button" title="Cancel AI request" onClick={cancelRequest}><StopCircle size={18}/></button>:<button className="send-question" aria-label="Send question" disabled={!input.trim()||voice.busy||voice.recording} onClick={()=>void ask()}><ArrowUp size={16}/></button>}</div></div></div><p className="ai-footnote">Review AI suggestions before sending.</p></div>
  </aside>;
}
