import {memo,useEffect,useMemo,useRef,useState} from 'react';
import {ChevronsRight,Clock,History,Plus,Square,Trash2,ExternalLink,StopCircle,CornerDownLeft} from './icons';
import {Avatar,Button,IconButton,Kbd,Keys,Notice,Spinner,Tooltip,confirmAction,cx} from './ui';
import type {Conversation,Draft,Settings,Thread} from '../shared/types';
import {dateLabel,invoke,uid} from './bridge';
import {useVoice} from './useVoice';
import {LevelMeter} from './LevelMeter';
import {Marked} from './components/MailList';

const holdDelay=220;
type Props={open:boolean;onClose:()=>void;onSearch:(query:string)=>void;conversations:Conversation[];threads:Thread[];accountId:string;settings:Settings;examples:string[];onThread:(id:string)=>void;onDraft:(draft:Partial<Draft>)=>void;notify:(t:string)=>void;currentDraft:()=>Draft|undefined;hasDraft:boolean;onApplyDraft:(proposal:Partial<Draft>)=>void};
export const Ask=memo(function Ask({open,onClose,onSearch,conversations,threads,accountId,settings,examples,onThread,onDraft,notify,currentDraft,hasDraft,onApplyDraft}:Props){
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
    const requestId=uid();request.current=requestId;const draft=currentDraft();const snapshot=fingerprint(draft);
    setBusy(true);setError('');setPending(text);setInput('');setHistory(false);
    try{
      const result=await invoke<Conversation>('ai.ask',{conversationId:id,message:text,accountId,draft,requestId});
      if(!mounted.current||request.current!==requestId)return;
      snapshots.current.set(`${result.id}:${result.messages.length-1}`,snapshot);setId(result.id);
    }catch(error){if(mounted.current&&request.current===requestId){setError((error as Error).message);setInput(text);}}
    finally{if(mounted.current&&request.current===requestId){request.current=undefined;setBusy(false);setPending('');}}
  }
  const askLatest=useRef(ask);askLatest.current=ask;
  function cancelRequest(){const requestId=request.current;if(requestId)void invoke('ai.cancel',{requestId}).catch(error=>{if(mounted.current)setError(error.message);});}
  async function apply(proposal:Partial<Draft>,index:number){
    const fields:Partial<Draft>={};
    for(const key of ['to','cc','bcc','subject','html'] as const){const value=proposal[key];if(typeof value==='string'&&(key==='html'||value.trim()))fields[key]=value;}
    const draft=currentDraft();
    if(draft){
      const snapshot=snapshots.current.get(`${id}:${index}`);
      if(snapshot!==fingerprint(draft)&&!await confirmAction({title:'Apply this suggestion?',message:'The draft changed since this suggestion was written. Applying it replaces the matching fields.',confirmLabel:'Apply'}))return;
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
      if(request.current||(hasDraft&&!panel.current?.contains(target)))return;
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
      <IconButton className="ask-collapse" label="Hide Ask" shortcut="Esc" icon={ChevronsRight} onClick={onClose}/>
      <div className="ask-column">
        <div className={cx('ask-field',recording&&'recording',busy&&'is-busy')}>
          {recording&&<LevelMeter level={voice.level}/>}
          <textarea ref={field} aria-label="Ask your mailbox" placeholder={voice.preparing?'Getting the microphone ready…':recording?'Recording':'Ask'} rows={1} value={input} readOnly={recording} onChange={e=>setInput(e.target.value)} onKeyDown={e=>{if(e.key==='ArrowDown'&&showMatches&&matches.length&&!e.shiftKey){e.preventDefault();panel.current?.querySelector<HTMLElement>('.ask-match')?.focus();return;}if(e.key==='Enter'&&(e.metaKey||e.ctrlKey)){e.preventDefault();if(query)onSearch(query);return;}if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();void ask();}}}/>
          {busy?<IconButton size="sm" label="Cancel AI request" shortcut="Esc" icon={StopCircle} onClick={cancelRequest}/>
          :recording?<IconButton size="sm" label="Finish recording" icon={Square} iconSize={13} onClick={voice.stop}/>
          :voice.busy?<Spinner size={15} className="ask-spinner"/>
          :query?<Tooltip content="Ask" detail="⌘ ↵ searches instead" shortcut="↵"><button className="ask-send" aria-label="Send question" onClick={()=>void ask()}>Ask<CornerDownLeft size={13}/></button></Tooltip>
          :<Tooltip content="Record a question" detail="Or hold A anywhere and release to ask"><button className="ask-hold" aria-label="Record question" onClick={()=>{autoAsk.current=false;void voice.toggle();}}>Hold<Kbd size="sm">A</Kbd>to talk</button></Tooltip>}
        </div>
        {recording&&<p className="ask-recording-hint">Release to ask<span>·</span><Kbd size="sm">Esc</Kbd>to cancel</p>}
        {voice.busy&&!voice.preparing&&<p className="ask-recording-hint quiet">Transcribing with Groq…</p>}
        {error&&<Notice className="ask-notice">{error}</Notice>}
        {(conversation||history)&&!showMatches&&<div className="ask-tools"><Button variant="text" size="sm" icon={History} disabled={busy} onClick={()=>setHistory(!history)}>{history?'Back to chat':'History'}</Button><Button variant="text" size="sm" icon={Plus} disabled={busy} onClick={()=>{setId(undefined);setHistory(false);setError('');}}>New chat</Button></div>}
      </div>
    </div>
    {showMatches?<div className="ask-scroll ask-matches" onKeyDown={e=>{
      if(e.key!=='ArrowDown'&&e.key!=='ArrowUp')return;
      const items=[...e.currentTarget.querySelectorAll<HTMLElement>('.ask-match')];const index=items.indexOf(document.activeElement as HTMLElement);if(index<0)return;
      e.preventDefault();if(e.key==='ArrowUp'&&index===0)field.current?.focus();else items[Math.min(items.length-1,index+(e.key==='ArrowDown'?1:-1))]?.focus();
    }}>
      <button className="ask-match-all" onClick={()=>onSearch(query)}><Keys className="ask-keys" combo="⌘ ↵" size="sm"/>See every result</button>
      {matches.length?matches.map(t=>{const m=t.messages.at(-1)!;const words=query.split(/\s+/).filter(w=>w.length>1);return <button key={t.id} className="ask-match" onClick={()=>onThread(t.id)}><Avatar name={m.fromName||m.from} size={26}/><span><span className="ask-match-line"><strong><Marked text={m.fromName||m.from} terms={words}/></strong><span>{dateLabel(t.date)}</span></span><span className="ask-match-subject"><Marked text={t.subject} terms={words}/></span></span></button>;}):<p className="ask-no-match">No mail matches that yet.</p>}
    </div>
    :history?<div className="ask-history">{conversations.length===0&&<p className="muted">A fresh start. Ask your first question.</p>}{[...conversations].reverse().map(c=><div className="history-row" key={c.id}><button onClick={()=>{setId(c.id);setHistory(false);}}><Clock size={14}/><span>{c.title}</span></button><IconButton size="xs" label="Delete conversation" aria-label={'Delete conversation '+c.title} icon={Trash2} disabled={busy} onClick={()=>{void invoke('conversation.delete',{id:c.id}).then(()=>{if(id===c.id)setId(undefined);}).catch(e=>notify(e.message));}}/></div>)}</div>
    :<div className="ask-scroll">{!conversation&&!busy?<div className="ask-welcome"><p>Hold <Kbd>A</Kbd> to talk to your mail</p><button key={exampleIndex} className="ask-example" onClick={()=>void ask(example)}>“{example}”</button>{conversations.length>0&&<Button variant="text" size="sm" icon={History} className="ask-history-link" onClick={()=>setHistory(true)}>Earlier questions</Button>}</div>:<>{conversation?.messages.map((m,i)=><div key={i} className={'chat-message '+m.role}><div className="chat-text">{m.content}</div>{!!m.citations?.length&&<div className="citations">{m.citations.map(cid=>{const t=threads.find(t=>t.id===cid);return t&&<button key={cid} onClick={()=>onThread(cid)}><ExternalLink size={12}/><span>{t.subject}</span></button>;})}</div>}{m.proposal&&<div className="proposal"><strong>{m.proposal.subject||'New message'}</strong><p>{m.proposal.to}</p><Button variant="tinted" size="sm" onClick={()=>void apply(m.proposal!,i)}>{hasDraft?'Apply to open draft':'Open as a draft'}</Button></div>}</div>)}{busy&&<><div className="chat-message user"><div className="chat-text">{pending}</div></div><div className="thinking"><span/><span/><span/>Looking through your mail</div></>}<div ref={end}/></>}</div>}
    {conversation&&<p className="ai-footnote">Answers use the selected mailbox · Powered by Groq</p>}
  </aside>;
});
