import {useEffect,useRef,useState} from 'react';
import {ArrowUp,Clock,History,Loader2,Mic,Plus,Square,Trash2,ExternalLink,StopCircle} from 'lucide-react';
import type {Account,Conversation,Draft,Settings,Thread} from '../shared/types';
import {invoke,uid} from './bridge';
import {useVoice} from './useVoice';
export function Ask({conversations,threads,accountId,settings,examples,onThread,onDraft,notify,currentDraft,onApplyDraft}:{conversations:Conversation[];threads:Thread[];accountId:string;settings:Settings;examples:string[];onThread:(id:string)=>void;onDraft:(draft:Partial<Draft>)=>void;notify:(t:string)=>void;currentDraft?:Draft;onApplyDraft?:(proposal:Partial<Draft>)=>void}){
  const [id,setId]=useState<string|undefined>();const [input,setInput]=useState('');const [busy,setBusy]=useState(false);const [history,setHistory]=useState(false);const [error,setError]=useState('');const [pending,setPending]=useState('');
  const end=useRef<HTMLDivElement>(null);const field=useRef<HTMLTextAreaElement>(null);const [exampleIndex,setExampleIndex]=useState(()=>Math.floor(Math.random()*examples.length));const panel=useRef<HTMLElement>(null);const conversation=conversations.find(c=>c.id===id);
  const mounted=useRef(true);const request=useRef<string|undefined>(undefined);const held=useRef(false);const snapshots=useRef(new Map<string,string>());
  function fingerprint(draft?:Draft){return draft?JSON.stringify([draft.id,draft.to,draft.cc,draft.bcc,draft.subject,draft.html,draft.attachments.map(a=>a.id)]):'';}
  useEffect(()=>{const area=field.current;if(!area)return;area.style.height='auto';area.style.height=Math.min(area.scrollHeight,132)+'px';},[input]);
  useEffect(()=>{if(conversation||busy)return;const timer=setInterval(()=>setExampleIndex(index=>index+1),7000);return()=>clearInterval(timer);},[!!conversation,busy]);
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
  const example=examples[exampleIndex%examples.length];
  const listening=voice.recording||voice.preparing||voice.busy;
  return <aside ref={panel} className="ask-panel" aria-label="Ask Aplos" onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();voice.cancel();cancelRequest();(document.activeElement as HTMLElement|null)?.blur();}}}>
    <div className="ask-head">
      <div className={'ask-field '+(voice.recording?'recording':'')}><textarea ref={field} aria-label="Ask your mailbox" placeholder={voice.recording?'Listening…':'Ask'} rows={1} value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();void ask();}}}/>
        {busy?<button className="icon-button tiny" title="Cancel AI request" aria-label="Cancel AI request" onClick={cancelRequest}><StopCircle size={16}/></button>:input.trim()?<button className="send-question" aria-label="Send question" disabled={voice.busy||voice.recording} onClick={()=>void ask()}><ArrowUp size={15}/></button>:<><button className={'icon-button tiny '+(voice.recording?'recording':'')} title={voice.recording?'Finish recording':'Record question'} aria-label={voice.recording?'Finish recording':'Record question'} disabled={voice.busy} onClick={voice.toggle}>{voice.busy?<Loader2 size={15} className="spin"/>:voice.recording?<Square size={14}/>:<Mic size={15}/>}</button><kbd>A</kbd></>}
      </div>
      {listening&&<div className="voice-status"><span className="recording-dot"/>{voice.preparing?'Preparing microphone…':voice.busy?'Transcribing with Groq…':'Listening · release A to finish'}<button onClick={voice.cancel}>Cancel</button></div>}
      {error&&<div className="inline-error" role="alert">{error}</div>}
      {(conversation||conversations.length>0)&&<div className="ask-tools"><button className="text-button" disabled={busy} onClick={()=>setHistory(!history)}><History size={14}/>{history?'Back to chat':'History'}</button>{(conversation||history)&&<button className="text-button" disabled={busy} onClick={()=>{setId(undefined);setHistory(false);setError('');}}><Plus size={14}/>New chat</button>}</div>}
    </div>
    {history?<div className="ask-history">{conversations.length===0&&<p className="muted">A fresh start. Ask your first question.</p>}{[...conversations].reverse().map(c=><div className="history-row" key={c.id}><button onClick={()=>{setId(c.id);setHistory(false);}}><Clock size={14}/><span>{c.title}</span></button><button className="icon-button tiny" title="Delete conversation" aria-label={'Delete conversation '+c.title} disabled={busy} onClick={()=>{void invoke('conversation.delete',{id:c.id}).then(()=>{if(id===c.id)setId(undefined);}).catch(e=>notify(e.message));}}><Trash2 size={14}/></button></div>)}</div>
    :<div className="ask-scroll">{!conversation&&!busy?<div className="ask-welcome"><p>Hold <kbd>A</kbd> and ask a question</p><button className="ask-example" title="Ask this" onClick={()=>void ask(example)}>“{example}”</button></div>:<>{conversation?.messages.map((m,i)=><div key={i} className={'chat-message '+m.role}><div className="chat-text">{m.content}</div>{!!m.citations?.length&&<div className="citations">{m.citations.map(cid=>{const t=threads.find(t=>t.id===cid);return t&&<button key={cid} onClick={()=>onThread(cid)}><ExternalLink size={12}/><span>{t.subject}</span></button>;})}</div>}{m.proposal&&<div className="proposal"><strong>{m.proposal.subject||'New message'}</strong><p>{m.proposal.to}</p><button className="secondary" onClick={()=>apply(m.proposal!,i)}>{currentDraft?'Apply to open draft':'Open as a draft'}</button></div>}</div>)}{busy&&<><div className="chat-message user"><div className="chat-text">{pending}</div></div><div className="thinking"><span/><span/><span/>Looking through your mail</div></>}<div ref={end}/></>}</div>}
    <p className="ai-footnote">Answers use the selected mailbox · Powered by Groq</p>
  </aside>;
}
