import {memo,useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {CalendarDays,Clock,CornerDownLeft,FileText,History,Home,Keyboard,Mic,Plus,Search,Sparkles,Square,SquarePen,Trash2,Wand} from './icons';
import {Avatar,Button,IconButton,Kbd,Keys,Notice,Spinner,Tooltip,confirmAction,cx,dialogOpen,type Icon} from './ui';
import type {Account,CalendarEvent,Conversation,Draft,Settings,Thread} from '../shared/types';
import {dateLabel,invoke,uid} from './bridge';
import {useVoice} from './useVoice';
import {LevelMeter} from './LevelMeter';
import {Marked} from './components/MailList';
import {AskEvent} from './AskEvent';
import type {Contact} from './Compose';

const holdDelay=220;
const timeZone=Intl.DateTimeFormat().resolvedOptions().timeZone;
type Props={open:boolean;onOpen:()=>void;onClose:()=>void;onSearch:(query:string)=>void;onCommand:(command:string)=>void;
  conversations:Conversation[];threads:Thread[];events:CalendarEvent[];accounts:Account[];contacts:Contact[];accountId:string;settings:Settings;examples:string[];
  onThread:(id:string)=>void;onDraft:(draft:Partial<Draft>)=>void;notify:(t:string)=>void;currentDraft:()=>Draft|undefined;hasDraft:boolean;onApplyDraft:(proposal:Partial<Draft>)=>void;onEditEvent:(event:Partial<CalendarEvent>)=>void};
type Item={key:string;group?:string;icon:React.ReactNode;label:React.ReactNode;detail?:React.ReactNode;keys?:string;run:()=>void};
const commands:{id:string;label:string;icon:Icon;keys?:string;words?:string}[]=[
  {id:'compose',label:'Compose',icon:SquarePen,keys:'C',words:'new email write'},
  {id:'home',label:'Go to Home',icon:Home,keys:'⌃ 1',words:'inbox'},
  {id:'later',label:'Go to Later',icon:Clock,keys:'⌃ 2',words:'todo bookmarks'},
  {id:'calendar',label:'Go to Calendar',icon:CalendarDays,keys:'⌃ 8',words:'events schedule plans'},
  {id:'drafts',label:'Go to Drafts',icon:FileText,keys:'⌃ 4'},
  {id:'settings',label:'Go to Settings',icon:Wand,keys:'⌘ ,',words:'preferences accounts'},
  {id:'search',label:'Search all mail',icon:Search,keys:'/',words:'find'},
  {id:'shortcuts',label:'Keyboard shortcuts',icon:Keyboard,keys:'?',words:'help keys'},
];

// The typed character, so layouts other than QWERTY use the key labelled A.
const isA=(event:KeyboardEvent)=>event.key.toLowerCase()==='a';

/** The top-bar pill and the Ask palette. Tap A to type, hold A (or the pill) to talk; nothing acts without a click. */
export const Ask=memo(function Ask({open,onOpen,onClose,onSearch,onCommand,conversations,threads,events,accounts,contacts,accountId,settings,examples,onThread,onDraft,notify,currentDraft,hasDraft,onApplyDraft,onEditEvent}:Props){
  const [id,setId]=useState<string|undefined>();const [input,setInput]=useState('');const [busy,setBusy]=useState(false);const [history,setHistory]=useState(false);const [error,setError]=useState('');const [pending,setPending]=useState('');
  const [active,setActive]=useState(0);const [holding,setHolding]=useState(false);const [saved,setSaved]=useState<Record<string,string>>({});
  const field=useRef<HTMLTextAreaElement>(null);const panel=useRef<HTMLElement>(null);const scroller=useRef<HTMLDivElement>(null);const conversation=conversations.find(c=>c.id===id);
  const mounted=useRef(true);const request=useRef<string|undefined>(undefined);const snapshots=useRef(new Map<string,string>());
  const openRef=useRef(open);openRef.current=open;const returnFocus=useRef<HTMLElement|null>(null);
  const hold=useRef<{timer?:ReturnType<typeof setTimeout>;recording:boolean}|null>(null);const autoAsk=useRef(false);
  function fingerprint(draft?:Draft){return draft?JSON.stringify([draft.id,draft.to,draft.cc,draft.bcc,draft.subject,draft.html,draft.attachments.map(a=>a.id)]):'';}
  useEffect(()=>{const area=field.current;if(!area)return;area.style.height='auto';area.style.height=Math.min(area.scrollHeight,120)+'px';},[input]);
  // Focus the input on open; give focus back to where it was on close.
  useLayoutEffect(()=>{
    if(open){if(!panel.current?.contains(document.activeElement))returnFocus.current=document.activeElement as HTMLElement|null;requestAnimationFrame(()=>field.current?.focus());}
    else if(panel.current?.contains(document.activeElement)){const back=returnFocus.current;if(back?.isConnected&&back!==document.body)back.focus();else(document.activeElement as HTMLElement).blur();}
  },[open]);
  async function ask(text=input){
    if(!text.trim()||request.current||voice.isActive())return;
    const requestId=uid();request.current=requestId;const draft=currentDraft();const snapshot=fingerprint(draft);
    setBusy(true);setError('');setPending(text.trim());setInput('');setHistory(false);
    try{
      const result=await invoke<Conversation>('ai.ask',{conversationId:id,message:text,accountId,draft,requestId,timeZone});
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
      close();onApplyDraft(fields);notify('Suggestion applied. Review the draft before sending.');
    }else onDraft(fields);
  }
  const voice=useVoice(settings.microphone,text=>{
    const auto=autoAsk.current;autoAsk.current=false;
    if(auto&&text.trim()){setInput(text);setTimeout(()=>void askLatest.current(text),0);return;}// ask once the recorder settles to idle
    if(auto){setError('I didn’t catch that. Try again, a little closer to the mic.');return;}
    setInput(text);field.current?.focus();
  },message=>{setError(message);if(!openRef.current)onOpen();});
  function cancelVoice(){autoAsk.current=false;setHolding(false);if(hold.current){clearTimeout(hold.current.timer);hold.current=null;}voice.cancel();}
  // Press-and-hold, shared by the A key and the pill: a short tap opens the palette, a hold records and asks on release.
  function press(){
    if(hold.current)return;
    const state:{timer?:ReturnType<typeof setTimeout>;recording:boolean}={recording:false};setHolding(true);
    state.timer=setTimeout(()=>{if(request.current||voice.isActive())return;state.recording=true;autoAsk.current=true;setError('');void voice.start();},holdDelay);
    hold.current=state;
  }
  function release(){
    const state=hold.current;if(!state)return;hold.current=null;clearTimeout(state.timer);setHolding(false);
    if(state.recording)voice.stop();
    onOpen();
  }
  useEffect(()=>{
    const down=(event:KeyboardEvent)=>{
      const target=event.target as HTMLElement;
      if(event.key==='Escape'&&!openRef.current&&(hold.current||voice.isActive())){event.preventDefault();event.stopPropagation();cancelVoice();return;}
      // Focus can fall to the page when a focused control inside the palette goes away; keystrokes still belong to Ask.
      if(openRef.current&&!panel.current?.contains(target)&&!dialogOpen()){event.stopPropagation();field.current?.focus();if(paletteKey(event))event.preventDefault();return;}
      if(!isA(event)||event.metaKey||event.ctrlKey||event.altKey||event.shiftKey||openRef.current||dialogOpen()||hasDraft||['INPUT','TEXTAREA','SELECT'].includes(target.tagName)||target.isContentEditable)return;
      event.preventDefault();event.stopPropagation();
      if(!event.repeat)press();
    };
    const up=(event:KeyboardEvent)=>{if(isA(event)&&hold.current)release();};
    const blur=()=>{if(hold.current?.recording)release();else if(hold.current){clearTimeout(hold.current.timer);hold.current=null;setHolding(false);}};
    // Capture so the list's own shortcuts never see a press that belongs to Ask.
    window.addEventListener('keydown',down,true);window.addEventListener('keyup',up);window.addEventListener('blur',blur);
    return()=>{window.removeEventListener('keydown',down,true);window.removeEventListener('keyup',up);window.removeEventListener('blur',blur);};
  });
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;cancelRequest();};},[]);
  const query=input.trim();
  const matches=useMemo(()=>{
    if(!query||conversation)return [];
    const words=query.toLowerCase().split(/\s+/).filter(Boolean);
    return threads.filter(t=>(accountId==='all'||t.accountId===accountId)&&t.status!=='trash'&&t.status!=='spam').filter(t=>{const text=[t.subject,t.summary,...t.messages.map(m=>m.fromName+' '+m.from)].join(' ').toLowerCase();return words.every(word=>text.includes(word));}).sort((a,b)=>b.date.localeCompare(a.date)).slice(0,5);
  },[query,threads,accountId,!!conversation]);
  const close=()=>{setHistory(false);onClose();};
  const runCommand=(command:string)=>{close();onCommand(command);};
  const commandItem=(c:typeof commands[number],group?:string):Item=>({key:'cmd-'+c.id,group,icon:<c.icon size={15}/>,label:c.label,keys:c.keys,run:()=>runCommand(c.id)});
  // A calendar example with someone this mailbox actually writes to shows that Ask can schedule too.
  const suggestions=useMemo(()=>{const person=contacts.find(c=>/^\p{Lu}\p{L}+ \p{L}/u.test(c.name))?.name.split(' ')[0];return [...examples,person?`Book lunch with ${person} Friday at noon`:'Add lunch on Friday at noon to my calendar'];},[examples,contacts]);
  const voiceBusy=voice.recording||voice.busy;
  const items=useMemo<Item[]>(()=>{
    if(conversation||busy||history||voiceBusy)return [];
    if(!query)return [
      ...suggestions.map((example,i):Item=>({key:'ex'+i,group:'Try asking',icon:<Sparkles size={15}/>,label:example,run:()=>void askLatest.current(example)})),
      ...[...conversations].reverse().slice(0,3).map((c):Item=>({key:'c'+c.id,group:'Recent',icon:<History size={15}/>,label:<><span className="muted">Continue:</span> {c.title}</>,run:()=>{setId(c.id);setInput('');}})),
      ...commands.map(c=>commandItem(c,'Commands')),
    ];
    const words=query.toLowerCase().split(/\s+/).filter(Boolean);const terms=query.split(/\s+/).filter(w=>w.length>1);
    return [
      {key:'ask',icon:<Sparkles size={15}/>,label:<>Ask Aplos: <strong>“{query}”</strong></>,run:()=>void askLatest.current()},
      ...matches.map((t):Item=>{const m=t.messages.at(-1)!;return {key:'t'+t.id,group:'Mail',icon:<Avatar name={m.fromName||m.from} size={22}/>,label:<><strong><Marked text={m.fromName||m.from} terms={terms}/></strong><span className="ask-item-subject"><Marked text={t.subject} terms={terms}/></span></>,detail:dateLabel(t.date),run:()=>{close();onThread(t.id);}};}),
      {key:'search',group:'Mail',icon:<Search size={15}/>,label:<>Search all mail for <strong>“{query}”</strong></>,keys:'⌘ ↵',run:()=>{close();onSearch(query);}},
      ...commands.filter(c=>words.every(w=>(c.label+' '+(c.words??'')).toLowerCase().split(/\s+/).some(x=>x.startsWith(w)))).map(c=>commandItem(c,'Commands')),
    ];
  },[query,matches,conversations,suggestions,!!conversation,busy,history,voiceBusy]);
  useEffect(()=>setActive(0),[query,items.length]);
  useEffect(()=>{panel.current?.querySelector('.ask-item.is-active')?.scrollIntoView({block:'nearest'});},[active]);
  // A new answer scrolls so its question sits at the top, rather than jumping to the end of a long reply.
  useLayoutEffect(()=>{const box=scroller.current;const last=box&&[...box.querySelectorAll<HTMLElement>('.ask-msg.user')].at(-1);if(box&&last)box.scrollTo({top:last.offsetTop-12,behavior:open?'smooth':'auto'});},[conversation?.messages.length,busy,id]);
  function newChat(){if(busy)return;setId(undefined);setHistory(false);setError('');setInput('');field.current?.focus();}
  /** Palette-wide keys; returns whether it handled one. */
  function paletteKey(event:{key:string;metaKey:boolean;ctrlKey:boolean}){
    const mod=event.metaKey||event.ctrlKey;
    if(event.key==='Escape'){if(voice.isActive()||request.current){cancelVoice();cancelRequest();}else if(history)setHistory(false);else if(input)setInput('');else close();return true;}
    if(mod&&event.key==='j'){close();return true;}
    if(mod&&event.key==='n'){newChat();return true;}
    if(mod&&event.key==='k'){runCommand('search');return true;}
    if(mod&&event.key===','){runCommand('settings');return true;}
    return false;
  }
  function keys(event:React.KeyboardEvent){
    // The palette owns the keyboard while open; nothing reaches the mail list behind it.
    event.stopPropagation();
    if(paletteKey(event))event.preventDefault();
  }
  function fieldKeys(event:React.KeyboardEvent<HTMLTextAreaElement>){
    if(event.nativeEvent.isComposing)return;
    if(items.length&&(event.key==='ArrowDown'||event.key==='ArrowUp')){event.preventDefault();setActive(i=>(i+(event.key==='ArrowDown'?1:-1)+items.length)%items.length);return;}
    if(event.key==='Enter'&&(event.metaKey||event.ctrlKey)){event.preventDefault();if(query){close();onSearch(query);}return;}
    if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();if(items.length&&!conversation)items[Math.min(active,items.length-1)]?.run();else void ask();}
  }
  const recording=voice.recording||voice.preparing;const transcribing=voice.busy&&!voice.preparing;
  const showList=items.length>0;const chat=!!conversation||busy;
  const pill=<div className={cx('ask-pill-wrap',recording&&!open&&'is-recording')}>
    <Tooltip content="Ask me anything" detail="Tap A to type · hold A to talk" shortcut="⌘ J">
      <button className={cx('ask-pill',recording&&!open&&'is-recording',holding&&!recording&&'is-holding')} aria-label={recording?'Recording. Release to ask':'Ask me anything'}
        onPointerDown={e=>{if(e.button!==0||open)return;e.currentTarget.setPointerCapture(e.pointerId);press();}}
        onPointerUp={()=>{if(hold.current)release();}} onPointerCancel={()=>{if(hold.current)cancelVoice();}}
        onClick={e=>{if(e.detail===0)onOpen();}}>
        <span className="ask-pill-idle"><Search size={15}/><span>Ask me anything</span><Kbd size="sm">A</Kbd><small>Hold to talk</small></span>
        <span className="ask-pill-live" aria-hidden={!recording}>{voice.preparing?<Spinner size={13}/>:<LevelMeter level={voice.level}/>}<span>{voice.preparing?'Starting mic…':'Recording'}</span></span>
      </button>
    </Tooltip>
    {recording&&!open&&<p className="ask-pill-hint" role="status">Release to ask<span>·</span><Kbd size="sm">Esc</Kbd>to cancel</p>}
  </div>;
  const body=history?<div className="ask-history">{conversations.length===0&&<p className="ask-empty">A fresh start. Ask your first question.</p>}{[...conversations].reverse().map(c=><div className="ask-history-row" key={c.id}><button onClick={()=>{setId(c.id);setHistory(false);field.current?.focus();}}><History size={14}/><span>{c.title}</span></button><IconButton size="xs" label="Delete conversation" aria-label={'Delete conversation '+c.title} icon={Trash2} disabled={busy} onClick={()=>{void invoke('conversation.delete',{id:c.id}).then(()=>{if(id===c.id)setId(undefined);}).catch(e=>notify(e.message));}}/></div>)}</div>
    :showList?<div className="ask-list" role="listbox" aria-label="Suggestions">{items.map((item,i)=><div key={item.key} className="ask-item-wrap">
      {item.group&&item.group!==items[i-1]?.group&&<p className="ask-group">{item.group}</p>}
      <button role="option" aria-selected={i===active} tabIndex={-1} className={cx('ask-item',i===active&&'is-active')} onPointerMove={()=>{if(active!==i)setActive(i);}} onMouseDown={e=>e.preventDefault()} onClick={item.run}>
        <span className="ask-item-icon">{item.icon}</span><span className="ask-item-label">{item.label}</span>
        {item.detail&&<span className="ask-item-detail">{item.detail}</span>}
        {i===active?<Keys combo="↵" size="sm"/>:item.keys&&<Keys combo={item.keys} size="sm" className="ask-item-keys"/>}
      </button></div>)}</div>
    :chat?<div className="ask-chat">{conversation?.messages.map((m,i)=><div key={i} className={'ask-msg '+m.role}>
      <div className="ask-msg-text">{m.role==='assistant'?<Prose text={m.content}/>:m.content}</div>
      {!!m.citations?.length&&<div className="ask-citations">{m.citations.map(cid=>{const t=threads.find(t=>t.id===cid);const last=t?.messages.at(-1);return t&&<button key={cid} onClick={()=>{close();onThread(cid);}}><Avatar name={last?.fromName||last?.from||t.subject} size={18}/><span>{t.subject}</span></button>;})}</div>}
      {m.proposal&&<div className="ask-draft"><span className="ask-draft-icon"><SquarePen size={15}/></span><span><strong>{m.proposal.subject||'New message'}</strong>{m.proposal.to&&<small>To {m.proposal.to}</small>}</span><Button variant="tinted" size="sm" onClick={()=>void apply(m.proposal!,i)}>{hasDraft?'Apply to open draft':'Open as draft'}</Button></div>}
      {m.event&&<AskEvent key={`${id}:${i}`} proposal={m.event} accounts={accounts} accountId={accountId} events={events} contacts={contacts} savedId={saved[`${id}:${i}`]} onSaved={eventId=>setSaved(s=>({...s,[`${id}:${i}`]:eventId}))} notify={notify} onEdit={event=>{close();onEditEvent(event);}} onCalendar={()=>runCommand('calendar')}/>}
    </div>)}
    {busy&&<><div className="ask-msg user"><div className="ask-msg-text">{pending}</div></div><div className="ask-thinking"><span className="ask-dots"><i/><i/><i/></span>Looking through your mail<Button variant="text" size="sm" onClick={cancelRequest}>Cancel</Button></div></>}</div>
    :null;
  const overlay=<div className={cx('ask-overlay',open&&'is-open')} inert={!open||undefined}>
    <div className="ask-backdrop" onPointerDown={close}/>
    <section ref={panel} className="ask-palette ui-surface" role="dialog" aria-modal="true" aria-label="Ask Aplos" onKeyDown={keys}>
      <div className={cx('ask-input',recording&&'is-recording')}>
        {recording?<LevelMeter level={voice.level}/>:<Search size={18} className="ask-input-icon"/>}
        <textarea ref={field} aria-label="Ask me anything" placeholder={voice.preparing?'Getting the microphone ready…':recording?'Listening…':transcribing?'Transcribing…':conversation?'Ask a follow-up':'Ask me anything'} rows={1} value={input} readOnly={recording||transcribing} onChange={e=>{setInput(e.target.value);if(history)setHistory(false);}} onKeyDown={fieldKeys}/>
        <div className="ask-input-end">
          {busy?<button className="ask-chip" onClick={cancelRequest}>Stop<Kbd size="sm">Esc</Kbd></button>
          :recording?<button className="ask-chip is-recording" onClick={voice.stop}><Square size={11}/>Done</button>
          :transcribing?<Spinner size={15} className="muted"/>
          :query?<button className="ask-chip is-go" onClick={()=>{if(items.length&&!conversation)items[Math.min(active,items.length-1)].run();else void ask();}}>{items.length&&!conversation&&items[active]?.key!=='ask'?'Open':'Ask'}<CornerDownLeft size={12}/></button>
          :<><IconButton size="sm" label="Talk instead" detail="Or hold A anywhere" icon={Mic} onClick={()=>{autoAsk.current=false;setError('');void voice.toggle();}}/><button className="ask-chip" aria-label="Close Ask" onClick={close}><Kbd>Esc</Kbd></button></>}
        </div>
      </div>
      {(transcribing||error)&&<div className="ask-status">{transcribing&&<p className="ask-transcribing"><Spinner size={13}/>Transcribing with Groq…</p>}{error&&<Notice className="ask-notice">{error}</Notice>}</div>}
      {body&&<div ref={scroller} className="ask-body">{body}</div>}
      <footer className="ask-footer">
        <span className="ask-hints">{showList?<><Keys combo="↑ ↓" size="sm"/>move<Keys combo="↵" size="sm"/>{items[active]?.key==='ask'?'ask':'open'}{!!query&&<><Keys combo="⌘ ↵" size="sm"/>search mail</>}</>:<><Keys combo="Hold A" size="sm"/>to talk<span className="ask-dot">·</span>Groq</>}</span>
        <span className="ask-footer-actions">
          {(conversation||busy)&&<Button variant="text" size="sm" icon={Plus} disabled={busy} shortcut="⌘ N" onClick={newChat}>New chat</Button>}
          {conversations.length>0&&<Button variant="text" size="sm" icon={History} disabled={busy} onClick={()=>setHistory(!history)}>{history?'Back':'History'}</Button>}
        </span>
      </footer>
    </section>
  </div>;
  return <>{pill}{createPortal(overlay,document.body)}</>;
});

/** Answers may use light Markdown: **bold** and "-" bullets. Everything else stays plain text. */
function Prose({text}:{text:string}){
  const inline=(line:string)=>line.split(/\*\*(.+?)\*\*/g).map((part,i)=>i%2?<strong key={i}>{part}</strong>:part);
  const blocks:React.ReactNode[]=[];let list:string[]=[];
  const flush=()=>{if(list.length)blocks.push(<ul key={blocks.length}>{list.map((item,i)=><li key={i}>{inline(item)}</li>)}</ul>);list=[];};
  for(const line of text.split('\n')){const bullet=/^\s*[-*•]\s+(.*)$/.exec(line);if(bullet){list.push(bullet[1]);continue;}flush();if(line.trim())blocks.push(<p key={blocks.length}>{inline(line)}</p>);}
  flush();return <>{blocks}</>;
}
