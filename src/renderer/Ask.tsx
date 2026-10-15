import {useEffect,useMemo,useRef,useState} from 'react';
import {ChevronsRight,Clock,History,Loader2,Plus,Square,Trash2,ExternalLink,StopCircle,CornerDownLeft} from './icons';
import type {Conversation,Draft,Settings,Thread} from '../shared/types';
import {avatarColor,dateLabel,invoke,uid} from './bridge';
import {useVoice} from './useVoice';
import {LevelMeter} from './LevelMeter';

const holdDelay=220;
type Props={open:boolean;onClose:()=>void;onSearch:(query:string)=>void;conversations:Conversation[];threads:Thread[];accountId:string;settings:Settings;examples:string[];onThread:(id:string)=>void;onDraft:(draft:Partial<Draft>)=>void;notify:(t:string)=>void;currentDraft?:Draft;onApplyDraft?:(proposal:Partial<Draft>)=>void};
export function Ask({open,onClose,onSearch,conversations,threads,accountId,settings,examples,onThread,onDraft,notify,currentDraft,onApplyDraft}:Props){
  const [id,setId]=useState<string|undefined>();const [input,setInput]=useState('');const [busy,setBusy]=useState(false);const [history,setHistory]=useState(false);const [error,setError]=useState('');const [pending,setPending]=useState('');
  const end=useRef<HTMLDivElement>(null);const field=useRef<HTMLTextAreaElement>(null);const [exampleIndex,setExampleIndex]=useState(()=>Math.floor(Math.random()*examples.length));const panel=useRef<HTMLElement>(null);const conversation=conversations.find(c=>c.id===id);
  const mounted=useRef(true);const request=useRef<string|undefined>(undefined);const snapshots=useRef(new Map<string,string>());
  // A short tap on A only opens and focuses the panel; holding it records and asks on release.
  const hold=useRef<{timer?:ReturnType<typeof setTimeout>;recording:boolean}|null>(null);const autoAsk=useRef(false);
  function fingerprint(draft?:Draft){return draft?JSON.stringify([draft.id,draft.to,draft.cc,draft.bcc,draft.subject,draft.html,draft.attachments.map(a=>a.id)]):'';}
  useEffect(()=>{const area=field.current;if(!area)return;area.style.height='auto';area.style.height=Math.min(area.scrollHeight,132)+'px';},[input]);
  useEffect(()=>{if(conversation||busy||!open)return;const timer=setInterval(()=>setExampleIndex(index=>index+1),7000);return()=>clearInterval(timer);},[!!conversation,busy,open]);
  useEffect(()=>{end.current?.scrollIntoView({behavior:'smooth'});},[conversation?.messages.length,busy]);
  async function ask(text=input){
    if(!text.trim()||request.current||voice.isActive())return;
    const requestId=uid();request.current=requestId;const snapshot=fingerprint(currentDraft);
    setBusy(true);setError('');setPending(text);setInput('');setHistory(false);
    try{
      const result=await invoke<Conversation>('ai.ask',{conversationId:id,message:text,accountId,draft:currentDraft,requestId});
      if(!mounted.current||request.current!==requestId)return;
      snapshots.current.set(`${result.id}:${result.messages.length-1}`,snapshot);setId(result.id);
    }catch(error){if(mounted.current&&request.current===requestId){setError((error as Error).message);setInput(text);}}
    finally{if(mounted.current&&request.current===requestId){request.current=undefined;setBusy(false);setPending('');}}
  }
  const askLatest=useRef(ask);askLatest.current=ask;
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
  const voice=useVoice(settings.microphone,text=>{
    if(autoAsk.current&&text.trim()){autoAsk.current=false;// The recorder settles to idle right after this callback; ask once it has.
      setTimeout(()=>void askLatest.current(text),0);return;}
    autoAsk.current=false;setInput(text);field.current?.focus();
  },setError);
  function cancelVoice(){autoAsk.current=false;if(hold.current){clearTimeout(hold.current.timer);hold.current=null;}voice.cancel();}
  useEffect(()=>{
    const down=(event:KeyboardEvent)=>{
      const target=event.target as HTMLElement;
      if(event.key==='Escape'&&(hold.current||voice.isActive())&&!panel.current?.contains(target)){event.preventDefault();cancelVoice();return;}
      if(event.code!=='KeyA'||event.metaKey||event.ctrlKey||event.altKey||['INPUT','TEXTAREA','SELECT'].includes(target.tagName)||target.isContentEditable)return;
      if(event.repeat){if(hold.current)event.preventDefault();return;}
      if(request.current||(currentDraft&&!panel.current?.contains(target)))return;
      event.preventDefault();
      const state:{timer?:ReturnType<typeof setTimeout>;recording:boolean}={recording:false};
      state.timer=setTimeout(()=>{state.recording=true;autoAsk.current=true;void voice.start();},holdDelay);
      hold.current=state;
    };
    const release=()=>{
      const state=hold.current;if(!state)return;hold.current=null;clearTimeout(state.timer);
      if(state.recording)voice.stop();else requestAnimationFrame(()=>field.current?.focus());
    };
    const up=(event:KeyboardEvent)=>{if(event.code==='KeyA')release();};
    const blur=()=>{if(hold.current?.recording)release();else if(hold.current){clearTimeout(hold.current.timer);hold.current=null;}};
    window.addEventListener('keydown',down);window.addEventListener('keyup',up);window.addEventListener('blur',blur);
    return()=>{window.removeEventListener('keydown',down);window.removeEventListener('keyup',up);window.removeEventListener('blur',blur);};
  });
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;cancelRequest();};},[]);
  const query=input.trim();
  const matches=useMemo(()=>{
    if(!query||conversation)return [];
    const words=query.toLowerCase().split(/\s+/).filter(Boolean);
    return threads.filter(t=>(accountId==='all'||t.accountId===accountId)&&t.status!=='trash'&&t.status!=='spam').filter(t=>{const text=[t.subject,t.summary,...t.messages.map(m=>m.fromName+' '+m.from)].join(' ').toLowerCase();return words.every(word=>text.includes(word));}).sort((a,b)=>b.date.localeCompare(a.date)).slice(0,6);
  },[query,threads,accountId,!!conversation]);
  const example=examples[exampleIndex%examples.length];
  const recording=voice.recording||voice.preparing;
  const showMatches=!!query&&!conversation&&!busy&&!history&&!recording;
  return <aside ref={panel} className="ask-panel" aria-label="Ask Aplos" onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();if(voice.isActive()||request.current){cancelVoice();cancelRequest();}else if(input)setInput('');else onClose();}}}>
    <div className="ask-head">
      <button className="icon-button ask-collapse" title="Hide Ask" aria-label="Hide Ask" onClick={onClose}><ChevronsRight size={16}/></button>
      <div className="ask-column">
        <div className={'ask-field '+(recording?'recording':'')}>
          {recording&&<LevelMeter level={voice.level}/>}
          <textarea ref={field} aria-label="Ask your mailbox" placeholder={voice.preparing?'Getting the microphone ready…':recording?'Recording':'Ask'} rows={1} value={input} readOnly={recording} onChange={e=>setInput(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&(e.metaKey||e.ctrlKey)){e.preventDefault();if(query)onSearch(query);return;}if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();void ask();}}}/>
          {busy?<button className="icon-button tiny" title="Cancel AI request" aria-label="Cancel AI request" onClick={cancelRequest}><StopCircle size={16}/></button>
          :recording?<button className="icon-button tiny" title="Finish recording" aria-label="Finish recording" onClick={voice.stop}><Square size={13}/></button>
          :voice.busy?<Loader2 size={15} className="spin ask-spinner"/>
          :query?<button className="ask-send" aria-label="Send question" onClick={()=>void ask()}>Ask<CornerDownLeft size={13}/></button>
          :<button className="ask-hold" title="Click to record a question" aria-label="Record question" onClick={()=>{autoAsk.current=false;void voice.toggle();}}>Hold<kbd>A</kbd>to talk</button>}
        </div>
        {recording&&<p className="ask-recording-hint">Release to ask<span>·</span><kbd>Esc</kbd>to cancel</p>}
        {voice.busy&&!voice.preparing&&<p className="ask-recording-hint quiet">Transcribing with Groq…</p>}
        {error&&<div className="inline-error" role="alert">{error}</div>}
        {(conversation||history)&&!showMatches&&<div className="ask-tools"><button className="text-button" disabled={busy} onClick={()=>setHistory(!history)}><History size={14}/>{history?'Back to chat':'History'}</button><button className="text-button" disabled={busy} onClick={()=>{setId(undefined);setHistory(false);setError('');}}><Plus size={14}/>New chat</button></div>}
      </div>
    </div>
    {showMatches?<div className="ask-scroll ask-matches">
      <button className="ask-match-all" onClick={()=>onSearch(query)}><span className="ask-keys"><kbd>⌘</kbd><kbd>↵</kbd></span>See every result</button>
      {matches.length?matches.map(t=>{const m=t.messages.at(-1)!;return <button key={t.id} className="ask-match" onClick={()=>onThread(t.id)}><span className="avatar" style={{background:avatarColor(m.fromName||m.from)}}>{(m.fromName||m.from)[0]?.toUpperCase()}</span><span><span className="ask-match-line"><strong>{m.fromName}</strong><span>{dateLabel(t.date)}</span></span><span className="ask-match-subject">{t.subject}</span></span></button>;}):<p className="ask-no-match">No mail matches that yet.</p>}
    </div>
    :history?<div className="ask-history">{conversations.length===0&&<p className="muted">A fresh start. Ask your first question.</p>}{[...conversations].reverse().map(c=><div className="history-row" key={c.id}><button onClick={()=>{setId(c.id);setHistory(false);}}><Clock size={14}/><span>{c.title}</span></button><button className="icon-button tiny" title="Delete conversation" aria-label={'Delete conversation '+c.title} disabled={busy} onClick={()=>{void invoke('conversation.delete',{id:c.id}).then(()=>{if(id===c.id)setId(undefined);}).catch(e=>notify(e.message));}}><Trash2 size={14}/></button></div>)}</div>
    :<div className="ask-scroll">{!conversation&&!busy?<div className="ask-welcome"><p>Hold <kbd>A</kbd> to talk to your mail</p><button className="ask-example" title="Ask this" onClick={()=>void ask(example)}>“{example}”</button>{conversations.length>0&&<button className="text-button ask-history-link" onClick={()=>setHistory(true)}><History size={13}/>Earlier questions</button>}</div>:<>{conversation?.messages.map((m,i)=><div key={i} className={'chat-message '+m.role}><div className="chat-text">{m.content}</div>{!!m.citations?.length&&<div className="citations">{m.citations.map(cid=>{const t=threads.find(t=>t.id===cid);return t&&<button key={cid} onClick={()=>onThread(cid)}><ExternalLink size={12}/><span>{t.subject}</span></button>;})}</div>}{m.proposal&&<div className="proposal"><strong>{m.proposal.subject||'New message'}</strong><p>{m.proposal.to}</p><button className="secondary" onClick={()=>apply(m.proposal!,i)}>{currentDraft?'Apply to open draft':'Open as a draft'}</button></div>}</div>)}{busy&&<><div className="chat-message user"><div className="chat-text">{pending}</div></div><div className="thinking"><span/><span/><span/>Looking through your mail</div></>}<div ref={end}/></>}</div>}
    {conversation&&<p className="ai-footnote">Answers use the selected mailbox · Powered by Groq</p>}
  </aside>;
}
