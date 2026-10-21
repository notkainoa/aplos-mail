import {memo,useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {CalendarDays,Check,ChevronLeft,ChevronRight,Clock,ExternalLink,Mail,MapPin,Plus,SquarePen,Trash2,Users,X} from './icons';
import type {Account,CalendarEvent,CalendarInfo,Thread} from '../shared/types';
import {invoke,openUrl,uid} from './bridge';
import {Button,Checkbox,Dialog,DialogClose,Field,IconButton,Notice,Popover,Select,Spinner,Tabs,confirmAction,cx,dialogOpen,toast,useHandlers,useLatest} from './ui';
import {addDays,clock,dayKey,localInput,moveStart,parseGuests,setAllDay as withAllDay,shortClock,shortRange,slotOn,timeRange,ymd} from './calendarTime';
import {allDayLanes,calendarIndex,eventsOnDay,layoutDay,mergeCalendars,shiftAnchor,viewDays,visibleEvents,type CalendarSource,type CalendarView} from './calendarLayout';

export function EventEditor({event,accounts,onClose,notify}:{event:Partial<CalendarEvent>;accounts:Account[];onClose:()=>void;notify:(s:string)=>void}){
 const [value,setValue]=useState<CalendarEvent>(()=>({id:event.id||uid(),accountId:event.accountId||accounts[0]?.id,calendarId:'primary',title:'',...slotOn(new Date()),allDay:false,location:'',description:'',guests:[],...event}));const [calendars,setCalendars]=useState<{id:string;name:string;accountId:string}[]>([]);const [busy,setBusy]=useState(false);const [error,setError]=useState('');
 const [guestText,setGuestText]=useState((event.guests??[]).join(', '));const [typingGuests,setTypingGuests]=useState(false);
 const [open,setOpen]=useState(true);
 useEffect(()=>{invoke<typeof calendars>('calendar.list',{accountId:value.accountId}).then(list=>{setCalendars(list);if(list.length)setValue(current=>list.some(c=>c.id===current.calendarId)?current:{...current,calendarId:list[0].id});}).catch(e=>setError(e.message));},[value.accountId]);
 function close(){setOpen(false);setTimeout(onClose,120);}
 const {guests,invalid:badGuests}=parseGuests(guestText);
 const backwards=+new Date(value.end)<=+new Date(value.start);
 const setStart=(next:string)=>setValue(v=>moveStart(v,next));
 const setAllDay=(allDay:boolean)=>setValue(v=>withAllDay(v,allDay));
 async function save(){setBusy(true);try{if(!value.title.trim())throw new Error('Give this event a title.');if(backwards)throw new Error('End time must be after start time.');if(badGuests.length)throw new Error(`Check ${badGuests.length===1?'this guest address':'these guest addresses'}: ${badGuests.join(', ')}`);await invoke('calendar.save',{event:{...value,guests}});notify('Calendar updated');close();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
 return <Dialog open={open} onClose={close} label="Calendar event" className="event-editor">
  <header><div className="title-with-icon"><CalendarDays size={19}/><strong>{event.id?'Event details':'Add to calendar'}</strong></div><DialogClose label="Close event" onClick={close}/></header>
  <div className="event-fields">
   <input className="event-title" aria-label="Event title" placeholder="Event title" autoFocus value={value.title} onChange={e=>setValue({...value,title:e.target.value})}/>
   <div className="field-grid">
    <Field label="Account"><Select variant="field" label="Account" value={value.accountId} options={accounts.map(a=>[a.id,a.email] as [string,string])} onChange={accountId=>setValue({...value,accountId,calendarId:'primary'})}/></Field>
    <Field label="Calendar"><Select variant="field" label="Calendar" value={value.calendarId} options={calendars.length?calendars.map(c=>[c.id,c.name] as [string,string]):[['primary','Primary calendar']]} onChange={calendarId=>setValue({...value,calendarId})}/></Field>
   </div>
   <div className="field-grid">
    <Field label="Starts"><input type={value.allDay?'date':'datetime-local'} aria-label="Starts" value={value.allDay?dayKey(value.start):localInput(value.start)} onChange={e=>{if(e.target.value)setStart(e.target.value);}}/></Field>
    {/* All-day ends are stored exclusive (as Google does) but shown as the last day of the event. */}
    <Field label="Ends"><input type={value.allDay?'date':'datetime-local'} aria-label="Ends" aria-invalid={backwards||undefined} min={value.allDay?dayKey(value.start):localInput(value.start)} value={value.allDay?addDays(value.end.slice(0,10),-1):localInput(value.end)} onChange={e=>{const next=e.target.value;if(next)setValue(v=>({...v,end:v.allDay?addDays(next,1):new Date(next).toISOString()}));}}/></Field>
   </div>
   {backwards&&<p className="field-error" role="alert">Ends before it starts.</p>}
   <Checkbox className="all-day" label="All-day event" checked={value.allDay} onChange={setAllDay}/>
   <Field label="Location"><input value={value.location} placeholder="Add a place or meeting link" onChange={e=>setValue({...value,location:e.target.value})}/></Field>
   <Field label="Guests"><input value={guestText} aria-invalid={(!typingGuests&&badGuests.length>0)||undefined} placeholder="Email addresses, separated by commas" onFocus={()=>setTypingGuests(true)} onChange={e=>setGuestText(e.target.value)} onBlur={()=>{setTypingGuests(false);setGuestText(guests.join(', '));}}/></Field>
   {!typingGuests&&badGuests.length>0&&<p className="field-error">{badGuests.length===1?`“${badGuests[0]}” isn’t an email address.`:`${badGuests.length} guests aren’t email addresses.`}</p>}
   <Field label="Notes"><textarea rows={3} value={value.description} onChange={e=>setValue({...value,description:e.target.value})}/></Field>
   {value.url&&<Button variant="text" iconRight={ExternalLink} onClick={()=>void openUrl(value.url!).catch(e=>setError(e.message))}>Open in Google Calendar</Button>}
   {error&&<Notice>{error}</Notice>}
  </div>
  <footer>{event.id?<Button variant="danger" size="sm" icon={Trash2} onClick={async()=>{if(!await confirmAction({title:'Delete this event?',message:value.title||undefined,confirmLabel:'Delete event',danger:true}))return;try{await invoke('calendar.delete',{id:event.id});notify('Event deleted');close();}catch(e){setError((e as Error).message);}}}>Delete event</Button>:<span className="muted small">You’ll see duplicates before adding.</span>}<Button variant="primary" icon={Check} loading={busy} onClick={()=>void save()}>Save event</Button></footer>
 </Dialog>;
}


const HOUR=48;const SNAP=15;const viewStorageKey='aplos.calendar.view';const lastCalendarKey='aplos.calendar.last';
const viewLabels:Record<CalendarView,string>={day:'Day',week:'Week',month:'Month'};
const todayKey=()=>ymd(new Date());
const dateOf=(day:string)=>new Date(day+'T00:00:00');
/** A wall-clock time on a day; minutes past midnight may run over into the next day. */
const wall=(day:string,minutes:number)=>{const d=dateOf(day);d.setMinutes(minutes);return d;};
const minutesInto=(iso:string,day:string)=>(+new Date(iso)-+dateOf(day))/60000;
const dayLabel=(day:string,options:Intl.DateTimeFormatOptions)=>dateOf(day).toLocaleDateString([],options);
const hourLabel=(h:number)=>new Date(2000,0,1,h).toLocaleTimeString([],{hour:'numeric'});
const accountLabel=(a?:Account)=>!a?'':a.provider==='demo'?(a.id==='work'?'Work':'Personal'):a.email;
/** "Team · Work": the account only when it adds something. */
const calendarLabel=(s:CalendarSource,a?:Account)=>{const owner=accountLabel(a);return owner&&owner!==s.name?`${s.name} · ${owner}`:s.name;};
const zoneName=()=>new Intl.DateTimeFormat([],{timeZoneName:'short'}).formatToParts(new Date()).find(p=>p.type==='timeZoneName')?.value??'';
/** "October 2026", "Oct – Nov 2026" for a week across months, or the full date for a day. */
function rangeTitle(view:CalendarView,days:string[],anchor:string):[string,string]{
  if(view==='day')return [dayLabel(anchor,{weekday:'long',month:'long',day:'numeric'}),anchor.slice(0,4)];
  if(view==='month')return [dayLabel(anchor,{month:'long'}),anchor.slice(0,4)];
  const first=days[0],last=days[days.length-1];
  if(first.slice(0,7)===last.slice(0,7))return [dayLabel(first,{month:'long'}),first.slice(0,4)];
  return [`${dayLabel(first,{month:'short'})} – ${dayLabel(last,{month:'short'})}`,last.slice(0,4)];
}

/** The current minute, for the now line. Only the time grid listens, so the rest of the app never re-renders for it. */
function useNow(){
  const [now,setNow]=useState(()=>new Date());
  useEffect(()=>{let timer:ReturnType<typeof setTimeout>;const tick=()=>{setNow(new Date());timer=setTimeout(tick,60_000-Date.now()%60_000+50);};timer=setTimeout(tick,60_000-Date.now()%60_000+50);return ()=>clearTimeout(timer);},[]);
  return now;
}

type SourceOf=(event:Pick<CalendarEvent,'accountId'|'calendarId'>)=>CalendarSource|undefined;
/** An event being created: where it sits and which calendar it goes to. */
type DraftEvent={start:string;end:string;allDay:boolean;calendar:string;anchor?:HTMLElement};
type CalendarProps={events:CalendarEvent[];accounts:Account[];accountId:string;hidden:string[];suggestions:Thread[];busyId?:string;
  /** Shortcuts pause while the composer is open. */ paused:boolean;
  edit:(event:Partial<CalendarEvent>)=>void;onThread:(id:string)=>void;onSchedule:(thread:Thread)=>void;onHidden:(keys:string[])=>void};

/**
 * The Calendar page: every calendar of every account in one week, day or month view, with a mini
 * month and the calendar list on the left. Plans are created by dragging on the grid, moved by
 * dragging and resized from their lower edge; nothing is saved without an explicit action.
 */
export const Calendar=memo(function Calendar({events,accounts,accountId,hidden,suggestions,busyId,paused,edit,onThread,onSchedule,onHidden}:CalendarProps){
  const [view,setViewState]=useState<CalendarView>(()=>{const saved=localStorage.getItem(viewStorageKey);return saved==='day'||saved==='month'?saved:'week';});
  const [anchor,setAnchor]=useState(todayKey);
  const [listed,setListed]=useState<CalendarInfo[]>([]);
  const [moved,setMoved]=useState<Record<string,{start:string;end:string}>>({});
  const [selection,setSelection]=useState<{id:string;anchor:HTMLElement}|null>(null);
  const [draft,setDraft]=useState<DraftEvent|null>(null);const [draftNode,setDraftNode]=useState<HTMLElement|null>(null);
  const [narrow,setNarrow]=useState(false);const [railOpen,setRailOpen]=useState(false);
  const page=useRef<HTMLDivElement>(null);const railButton=useRef<HTMLButtonElement>(null);
  const accountsKey=accounts.map(a=>a.id+(a.calendarConnected?'+':'')).join();
  useEffect(()=>{let live=true;invoke<CalendarInfo[]>('calendar.list',{accountId:'all'}).then(list=>{if(live)setListed(list);}).catch(()=>{});return ()=>{live=false;};},[accountsKey]);
  // Beside a narrow window (or Ask), the mini month and calendar list move into a popover.
  useLayoutEffect(()=>{const el=page.current;if(!el)return;const observer=new ResizeObserver(([entry])=>setNarrow(entry.contentRect.width<880));observer.observe(el);return ()=>observer.disconnect();},[]);
  const sources=useMemo(()=>mergeCalendars(accounts,listed,events),[accounts,listed,events]);
  const sourceOf=useMemo(()=>calendarIndex(sources),[sources]);
  const scoped=useMemo(()=>sources.filter(s=>accountId==='all'||s.accountId===accountId),[sources,accountId]);
  const shown=useMemo(()=>visibleEvents(events,sourceOf,accountId,hidden).map(e=>moved[e.id]?{...e,...moved[e.id]}:e),[events,sourceOf,accountId,hidden,moved]);
  const days=useMemo(()=>viewDays(view,anchor),[view,anchor]);
  const busyDays=useMemo(()=>{const set=new Set<string>();for(const e of shown){if(e.allDay){for(let d=e.start.slice(0,10),n=0;(d<e.end.slice(0,10)||n===0)&&n<62;d=addDays(d,1),n++)set.add(d);}else set.add(dayKey(e.start));}return set;},[shown]);
  const selected=selection&&shown.find(e=>e.id===selection.id);
  const [title,year]=rangeTitle(view,days,anchor);

  function setView(next:CalendarView){setViewState(next);localStorage.setItem(viewStorageKey,next);setSelection(null);setDraft(null);}
  const go=(day:string)=>{setAnchor(day);setSelection(null);setDraft(null);};
  const shift=(delta:number)=>go(shiftAnchor(view,anchor,delta));
  // New plans go to the calendar used last, while it is shown; otherwise the default calendar of the chosen account.
  function defaultCalendar(){
    const visible=scoped.filter(s=>!hidden.includes(s.key));const last=localStorage.getItem(lastCalendarKey);
    return (visible.find(s=>s.key===last)??visible.find(s=>s.primary)??visible[0]??scoped[0])?.key;
  }
  function startDraft(start:Date|string,end:Date|string,allDay:boolean,where?:HTMLElement){
    const calendar=defaultCalendar();if(!calendar){toast.show({text:'Connect a calendar in Settings → Accounts first.'});return;}
    setSelection(null);
    setDraft({start:typeof start==='string'?start:start.toISOString(),end:typeof end==='string'?end:end.toISOString(),allDay,calendar,anchor:where});
  }
  function newEvent(){
    const day=days.includes(todayKey())?todayKey():anchor;const slot=slotOn(dateOf(day));
    if(view==='month')startDraft(slot.start,slot.end,false,page.current?.querySelector<HTMLElement>(`[data-cell="${day}"]`)??undefined);
    else{if(!days.includes(day))go(day);startDraft(slot.start,slot.end,false);}
  }
  const handlers=useHandlers({
    open:(event:CalendarEvent,element:HTMLElement)=>{setDraft(null);setSelection(current=>current?.id===event.id?null:{id:event.id,anchor:element});},
    edit:(event:CalendarEvent)=>{setSelection(null);edit(events.find(e=>e.id===event.id)??event);},
    create:(start:Date|string,end:Date|string,allDay:boolean,where?:HTMLElement)=>startDraft(start,end,allDay,where),
    change:(event:CalendarEvent,start:string,end:string)=>void reschedule(event.id,start,end),
    day:(day:string)=>{setView('day');go(day);},
    pick:(day:string)=>go(day),
    draftNode:(node:HTMLElement|null)=>setDraftNode(node),
  });
  async function reschedule(id:string,start:string,end:string,undo=true){
    const original=events.find(e=>e.id===id);if(!original)return;
    setMoved(m=>({...m,[id]:{start,end}}));
    try{
      await invoke('calendar.save',{event:{...original,start,end}});
      if(undo)toast.show({text:`Moved “${original.title}” to ${dayLabel(dayKey(start),{weekday:'short'})} ${original.allDay?'':clock(start)}`.trim(),action:{label:'Undo',run:()=>void reschedule(id,original.start,original.end,false)}});
    }catch(e){toast.show({tone:'error',text:(e as Error).message});}
    finally{setMoved(m=>{const next={...m};delete next[id];return next;});}
  }
  async function remove(event:CalendarEvent){
    if(!await confirmAction({title:'Delete this event?',message:event.title||undefined,confirmLabel:'Delete event',danger:true}))return;
    setSelection(null);
    try{await invoke('calendar.delete',{id:event.id});toast.show({text:'Event deleted'});}catch(e){toast.show({tone:'error',text:(e as Error).message});}
  }
  function toggle(key:string){onHidden(hidden.includes(key)?hidden.filter(k=>k!==key):[...hidden,key]);}
  /** Shows only one calendar of those in view, or everything again when it already is the only one. */
  function only(key:string){
    const inScope=new Set(scoped.map(s=>s.key));const rest=hidden.filter(k=>!inScope.has(k));
    const alone=scoped.every(s=>s.key===key||hidden.includes(s.key))&&!hidden.includes(key);
    onHidden(alone?rest:[...rest,...scoped.filter(s=>s.key!==key).map(s=>s.key)]);
  }

  useEffect(()=>{
    function keydown(e:KeyboardEvent){
      if(paused||dialogOpen()||e.defaultPrevented||e.metaKey||e.ctrlKey||e.altKey)return;
      const element=e.target as HTMLElement;
      if(['INPUT','TEXTAREA','SELECT'].includes(element.tagName)||element.isContentEditable)return;
      // A focused control keeps Enter, Space and arrows; a focused event keeps Enter for itself.
      if(element.closest?.('button,[role=tab],[role=checkbox],[role=button]')&&element.matches(':focus-visible')&&['Enter',' ','ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key))return;
      const keys:Record<string,()=>void>={t:()=>go(todayKey()),d:()=>setView('day'),w:()=>setView('week'),m:()=>setView('month'),
        j:()=>shift(1),k:()=>shift(-1),ArrowRight:()=>shift(1),ArrowLeft:()=>shift(-1),n:newEvent};
      if(selected){keys.e=keys.Enter=()=>handlers.edit(selected);if(!selected.scheduling)keys.Backspace=keys.Delete=()=>void remove(selected);}
      const run=keys[e.key];if(run){e.preventDefault();run();}
    }
    addEventListener('keydown',keydown);return ()=>removeEventListener('keydown',keydown);
  });

  const visibleKeys=new Set(scoped.filter(s=>!hidden.includes(s.key)).map(s=>s.key));
  const rail=<div className="cal-rail-body">
    <MiniMonth anchor={anchor} range={days} busy={busyDays} onPick={handlers.pick}/>
    <CalendarList accounts={accounts} sources={scoped} visible={visibleKeys} onToggle={toggle} onOnly={only}/>
    {suggestions.length>0&&<section className="cal-suggestions" aria-label="Plans found in your mail">
      <h3>From your mail</h3>
      {suggestions.slice(0,4).map(t=><button key={t.id} className="cal-suggestion" onClick={()=>onSchedule(t)} disabled={busyId===t.id}>
        <span><strong>{t.messages[0]?.fromName||t.subject}</strong><small>{t.summary||t.subject}</small></span>
        {busyId===t.id?<Spinner size={13}/>:<Plus size={14}/>}
      </button>)}
      <p className="cal-rail-note">Groq reads the email and fills in the event. Nothing is added until you save it.</p>
    </section>}
  </div>;
  const draftSource=draft?scoped.find(s=>s.key===draft.calendar)??sources.find(s=>s.key===draft.calendar):undefined;
  const draftAnchor=draft?.anchor??draftNode;
  // Popovers keep their last content while they fade out.
  const card=useLatest(selected);const lastDraft=useLatest(draft);

  return <div ref={page} className={cx('calendar-page',narrow&&'is-narrow')}>
    {!narrow&&<aside className="cal-rail" aria-label="Calendars">{rail}</aside>}
    <section className="cal-main" aria-label="Calendar">
      <header className="cal-header">
        {narrow&&<IconButton ref={railButton} label="Calendars" icon={CalendarDays} active={railOpen} onClick={()=>setRailOpen(v=>!v)}/>}
        <h1 className="cal-title" aria-live="polite"><strong>{title}</strong> <span>{year}</span></h1>
        <div className="cal-nav">
          <Button variant="secondary" size="sm" className="cal-today" tooltip={{content:'Today',shortcut:'T'}} onClick={()=>go(todayKey())}>Today</Button>
          <IconButton size="sm" label={`Previous ${view}`} shortcut="K" icon={ChevronLeft} onClick={()=>shift(-1)}/>
          <IconButton size="sm" label={`Next ${view}`} shortcut="J" icon={ChevronRight} onClick={()=>shift(1)}/>
        </div>
        <div className="cal-header-end">
          <Tabs variant="segmented" semantics="nav" label="Calendar view" className="cal-views" value={view} onChange={setView}
            items={(['day','week','month'] as CalendarView[]).map(id=>({id,label:viewLabels[id],tooltip:{title:viewLabels[id]+' view',detail:`Press ${id[0].toUpperCase()}`}}))}/>
          <Button variant="pill" icon={Plus} shortcut="N" className="cal-new" onClick={newEvent}>New event</Button>
        </div>
      </header>
      {view==='month'
        ?<MonthGrid days={days} anchor={anchor} events={shown} sourceOf={sourceOf} selectedId={selection?.id} draft={draft} draftColor={draftSource?.color} overlay={!!draft||!!selection} {...handlers}/>
        :<TimeGrid days={days} events={shown} sourceOf={sourceOf} selectedId={selection?.id} draft={draft} draftColor={draftSource?.color} overlay={!!draft||!!selection} {...handlers}/>}
    </section>
    {narrow&&<Popover open={railOpen} anchor={railButton.current} onClose={()=>setRailOpen(false)} placement="bottom-start" className="ui-surface cal-rail-popover" label="Calendars">{rail}</Popover>}
    <Popover open={!!selected&&!!selection} anchor={selection?.anchor} onClose={()=>setSelection(null)} placement="right-start" gap={8} className="ui-surface cal-popover" role="dialog" label="Event">
      {card&&<EventCard event={card} source={sourceOf(card)} account={accounts.find(a=>a.id===card.accountId)} onEdit={()=>handlers.edit(card)} onDelete={()=>void remove(card)} onThread={onThread} onClose={()=>setSelection(null)}/>}
    </Popover>
    <Popover open={!!draft&&!!draftAnchor} anchor={draftAnchor} onClose={()=>setDraft(null)} placement="right-start" gap={8} className="ui-surface cal-popover" role="dialog" label="New event">
      {lastDraft&&<QuickCreate key={lastDraft.start+lastDraft.allDay} draft={lastDraft} sources={scoped} accounts={accounts}
        onCalendar={calendar=>setDraft(d=>d&&{...d,calendar})} onClose={()=>setDraft(null)}
        onMore={value=>{setDraft(null);edit(value);}}/>}
    </Popover>
  </div>;
});

type GridProps={days:string[];events:CalendarEvent[];sourceOf:SourceOf;selectedId?:string;draft:DraftEvent|null;draftColor?:string;
  /** A popover is open: a plain click on the grid only closes it. */ overlay:boolean;
  open:(event:CalendarEvent,element:HTMLElement)=>void;edit:(event:CalendarEvent)=>void;create:(start:Date|string,end:Date|string,allDay:boolean,where?:HTMLElement)=>void;
  change:(event:CalendarEvent,start:string,end:string)=>void;day:(day:string)=>void;draftNode:(node:HTMLElement|null)=>void};
type Gesture={kind:'create'|'move'|'resize';dismiss?:boolean;pointer:number;x:number;y:number;moved:boolean;index:number;day:string;start:number;end:number;origin:number;grab:number;event?:CalendarEvent;element?:HTMLElement};
type Preview={kind:Gesture['kind'];id?:string;index:number;start:number;end:number};

const eventStyle=(color?:string)=>({'--c':color??'var(--blue)'}) as React.CSSProperties;

/** Week and day views: a sticky row of days and all-day plans over a 24-hour grid. */
const TimeGrid=memo(function TimeGrid({days,events,sourceOf,selectedId,draft,draftColor,overlay,open,edit,create,change,day:showDay,draftNode}:GridProps){
  const now=useNow();const today=ymd(now);
  const scroller=useRef<HTMLDivElement>(null);const columns=useRef<HTMLDivElement>(null);const allDayRow=useRef<HTMLDivElement>(null);
  const gesture=useRef<Gesture|null>(null);const [preview,setPreview]=useState<Preview|null>(null);
  const placed=useMemo(()=>days.map(day=>layoutDay(events,day)),[days,events]);
  const {bars,lanes}=useMemo(()=>allDayLanes(events,days),[events,days]);
  const zone=useMemo(zoneName,[]);
  // Open on the working day, moved later when today's current time would be out of sight.
  useLayoutEffect(()=>{const el=scroller.current;if(!el)return;const shown=(el.clientHeight-110)/HOUR;const hour=new Date().getHours()+new Date().getMinutes()/60;
    el.scrollTop=Math.max(0,(days.includes(todayKey())&&hour>7+shown-1?hour-shown/2:7)*HOUR-12);},[days.length,days.includes(todayKey())]);
  useEffect(()=>{
    function cancel(e:KeyboardEvent){if(e.key==='Escape'&&gesture.current){e.preventDefault();e.stopPropagation();gesture.current=null;setPreview(null);}}
    addEventListener('keydown',cancel,true);return ()=>removeEventListener('keydown',cancel,true);
  },[]);
  useEffect(()=>{if(!draft||draft.allDay)return;requestAnimationFrame(()=>scroller.current?.querySelector('.cal-draft')?.scrollIntoView({block:'nearest'}));},[draft?.start]);
  function point(e:{clientX:number;clientY:number}){
    const r=columns.current!.getBoundingClientRect();const index=Math.max(0,Math.min(days.length-1,Math.floor((e.clientX-r.left)/(r.width/days.length))));
    return {index,minutes:Math.max(0,Math.min(1440,(e.clientY-r.top)/HOUR*60))};
  }
  function down(e:React.PointerEvent<HTMLDivElement>){
    if(e.button!==0||gesture.current)return;
    const target=e.target as HTMLElement;if(target.closest('.cal-draft'))return;
    const block=target.closest<HTMLElement>('[data-event-id]');const p=point(e);
    if(block){
      const event=events.find(x=>x.id===block.dataset.eventId);if(!event)return;
      const day=block.dataset.day!;const start=Math.max(0,minutesInto(event.start,day)),end=Math.min(1440,minutesInto(event.end,day));
      gesture.current={kind:target.closest('.cal-resize')?'resize':'move',pointer:e.pointerId,x:e.clientX,y:e.clientY,moved:false,index:days.indexOf(day),day,start,end,origin:start,grab:p.minutes-start,event,element:block};
    }else{
      const start=Math.floor(p.minutes/SNAP)*SNAP;
      gesture.current={kind:'create',dismiss:overlay,pointer:e.pointerId,x:e.clientX,y:e.clientY,moved:false,index:p.index,day:days[p.index],start,end:start+SNAP,origin:start,grab:0};
    }
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function move(e:React.PointerEvent<HTMLDivElement>){
    const g=gesture.current;if(!g||g.pointer!==e.pointerId)return;
    if(!g.moved){if(Math.hypot(e.clientX-g.x,e.clientY-g.y)<4||g.event?.scheduling)return;g.moved=true;}
    const box=scroller.current!.getBoundingClientRect();
    if(e.clientY<box.top+64)scroller.current!.scrollTop-=10;else if(e.clientY>box.bottom-32)scroller.current!.scrollTop+=10;
    const p=point(e);const snap=(m:number)=>Math.round(m/SNAP)*SNAP;
    if(g.kind==='create'){const at=snap(p.minutes);g.start=Math.min(g.origin,at);g.end=Math.max(g.origin+SNAP,at);if(g.end-g.start<SNAP)g.end=g.start+SNAP;}
    else if(g.kind==='move'){const length=g.end-g.start;g.start=Math.max(0,Math.min(1440-SNAP,snap(p.minutes-g.grab)));g.index=p.index;setPreview({kind:'move',id:g.event!.id,index:g.index,start:g.start,end:g.start+length});return;}
    else g.end=Math.max(g.start+SNAP,Math.min(1440,snap(p.minutes)));
    setPreview({kind:g.kind,id:g.event?.id,index:g.index,start:g.start,end:g.end});
  }
  function up(e:React.PointerEvent<HTMLDivElement>){
    const g=gesture.current;if(!g||g.pointer!==e.pointerId)return;
    gesture.current=null;setPreview(null);
    if(g.kind==='create'){
      // A click makes an hour-long plan; a drag makes exactly what was drawn.
      if(!g.moved&&g.dismiss)return;
      const start=g.moved?g.start:g.origin,end=g.moved?g.end:Math.min(1440,g.origin+60);
      create(wall(g.day,start),wall(g.day,end),false);return;
    }
    const event=g.event!;
    if(!g.moved){open(event,g.element!);return;}
    if(g.kind==='resize'){if(g.end!==minutesInto(event.end,g.day))change(event,event.start,wall(g.day,g.end).toISOString());return;}
    const shift=+wall(days[g.index],g.start)-+wall(g.day,g.origin);
    if(shift)change(event,new Date(+new Date(event.start)+shift).toISOString(),new Date(+new Date(event.end)+shift).toISOString());
  }
  function cancel(){gesture.current=null;setPreview(null);}
  function allDayCreate(e:React.MouseEvent<HTMLDivElement>){
    if((e.target as HTMLElement).closest('.cal-bar'))return;
    const r=e.currentTarget.getBoundingClientRect();const index=Math.max(0,Math.min(days.length-1,Math.floor((e.clientX-r.left)/(r.width/days.length))));
    create(days[index],addDays(days[index],1),true,allDayRow.current?.querySelectorAll<HTMLElement>('.cal-allday-cell')[index]);
  }
  const block=(e:CalendarEvent,day:string,box:{top:number;height:number;left:string;width:string},extra?:string)=>{
    const short=box.height<34;const endsToday=dayKey(new Date(+new Date(e.end)-1).toISOString())===day;
    return <div key={e.id+day} data-event-id={e.id} data-day={day} role="button" tabIndex={0} aria-label={`${e.title}, ${timeRange(e)}`}
      className={cx('cal-event',short&&'is-short',+new Date(e.end)<+now&&'is-past',selectedId===e.id&&'is-selected',e.scheduling&&'is-locked',extra)}
      style={{...eventStyle(sourceOf(e)?.color),top:box.top,height:box.height,left:box.left,width:box.width}}
      onKeyDown={k=>{if(k.key==='Enter'||k.key===' '){k.preventDefault();k.stopPropagation();open(e,k.currentTarget);}}}>
      <strong>{e.title||'Untitled'}</strong>{short?<span>{shortClock(e.start)}</span>:<span>{shortRange(e)}</span>}{!short&&box.height>=64&&e.location&&<span>{e.location}</span>}
      {!e.scheduling&&endsToday&&<i className="cal-resize" aria-hidden="true"/>}
    </div>;
  };
  const nowTop=(now.getHours()*60+now.getMinutes())/60*HOUR;
  const todayIndex=days.indexOf(today);
  return <div className={cx('cal-time',days.length===1&&'is-day')} style={{'--days':days.length,'--hour':HOUR+'px'} as React.CSSProperties}>
    <div className="cal-scroll" ref={scroller}>
      <div className="cal-sticky">
        <div className="cal-days">
          <span className="cal-zone">{zone}</span>
          {days.map(day=><button key={day} className={cx('cal-dayhead',day===today&&'is-today',day<today&&'is-past')} onClick={()=>showDay(day)} aria-label={dayLabel(day,{weekday:'long',month:'long',day:'numeric'})}>
            <span>{dayLabel(day,{weekday:'short'})}</span><strong>{Number(day.slice(8))}</strong>
          </button>)}
        </div>
        <div className="cal-allday">
          <span className="cal-gutter-label">All day</span>
          <div className="cal-allday-grid" ref={allDayRow} style={{'--lanes':Math.max(1,lanes)} as React.CSSProperties} onDoubleClick={allDayCreate}>
            {days.map((day,i)=><span key={day} className="cal-allday-cell" style={{gridColumn:i+1}}>{draft?.allDay&&draft.start===day&&<span className="cal-bar cal-draft" style={eventStyle(draftColor)} ref={draftNode}>New event</span>}</span>)}
            {bars.map(({event:e,from,to,lane})=><button key={e.id} className={cx('cal-bar',selectedId===e.id&&'is-selected',e.end.slice(0,10)<=today&&'is-past')} style={{...eventStyle(sourceOf(e)?.color),gridColumn:`${from+1} / ${to+2}`,gridRow:lane+1}}
              onClick={ev=>open(e,ev.currentTarget)} onDoubleClick={ev=>{ev.stopPropagation();edit(e);}}>{e.title||'Untitled'}</button>)}
          </div>
        </div>
      </div>
      <div className="cal-body" style={{height:24*HOUR}}>
        <div className="cal-gutter" aria-hidden="true">{Array.from({length:23},(_,i)=><span key={i} style={{top:(i+1)*HOUR}}>{hourLabel(i+1)}</span>)}
          {todayIndex>=0&&<time className="cal-now-label" style={{top:nowTop}}>{clock(now.toISOString())}</time>}</div>
        <div className="cal-columns" ref={columns} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={cancel}
          onDoubleClick={e=>{const el=(e.target as HTMLElement).closest<HTMLElement>('[data-event-id]');const event=el&&events.find(x=>x.id===el.dataset.eventId);if(event)edit(event);}}>
          {todayIndex>=0&&<div className="cal-now-faint" style={{top:nowTop}}/>}
          {days.map((day,i)=><div key={day} className={cx('cal-column',day===today&&'is-today')}>
            {placed[i].map(p=>{
              const dragging=preview&&preview.id===p.event.id&&preview.kind!=='create';
              // Overlapping plans cascade: each reaches into its neighbour's column, and later ones sit on top.
              const last=p.column+p.span>=p.columns||days.length===1;const width=last?p.span/p.columns:Math.min((p.columns-p.column)/p.columns,p.span*1.7/p.columns);
              const box={top:p.start/60*HOUR+1,height:Math.max(18,(p.end-p.start)/60*HOUR-2),left:`calc(${p.column/p.columns*100}% + 1px)`,width:`calc(${width*100}% - ${last?6:3}px)`};
              return block(p.event,day,box,dragging?'is-origin':undefined);
            })}
            {preview&&preview.index===i&&(()=>{const e=preview.id?events.find(x=>x.id===preview.id):undefined;
              const box={top:preview.start/60*HOUR+1,height:Math.max(18,(preview.end-preview.start)/60*HOUR-2),left:'1px',width:'calc(100% - 6px)'};
              const ghost={start:wall(day,preview.start).toISOString(),end:wall(day,preview.end).toISOString(),allDay:false};
              return <div className="cal-event is-dragging" style={{...eventStyle(e?sourceOf(e)?.color:draftColor),...box}} aria-hidden="true"><strong>{e?.title||'New event'}</strong><span>{shortRange(ghost)}</span></div>;})()}
            {draft&&!draft.allDay&&dayKey(draft.start)===day&&!preview&&(()=>{const start=minutesInto(draft.start,day),end=Math.min(1440,minutesInto(draft.end,day));
              return <div ref={draftNode} className="cal-event cal-draft" style={{...eventStyle(draftColor),top:start/60*HOUR+1,height:Math.max(18,(end-start)/60*HOUR-2),left:'1px',width:'calc(100% - 6px)'}}><strong>New event</strong><span>{shortRange(draft)}</span></div>;})()}
            {day===today&&<div className="cal-now" style={{top:nowTop}}/>}
          </div>)}
        </div>
      </div>
    </div>
  </div>;
});

/** Month view: six weeks of days, each with as many plans as fit and a count of the rest. */
const MonthGrid=memo(function MonthGrid({days,anchor,events,sourceOf,selectedId,draft,draftColor,open,create,day:showDay,draftNode}:GridProps&{anchor:string}){
  const grid=useRef<HTMLDivElement>(null);const [rowHeight,setRowHeight]=useState(110);const today=todayKey();
  useLayoutEffect(()=>{const el=grid.current;if(!el)return;const observer=new ResizeObserver(([entry])=>setRowHeight(entry.contentRect.height/6));observer.observe(el);return ()=>observer.disconnect();},[]);
  const fit=Math.max(1,Math.floor((rowHeight-30)/21));const month=anchor.slice(0,7);
  return <div className="cal-month">
    <div className="cal-month-head">{days.slice(0,7).map(day=><span key={day}>{dayLabel(day,{weekday:'short'})}</span>)}</div>
    <div className="cal-month-grid" ref={grid}>
      {days.map(day=>{
        const list=eventsOnDay(events,day);const visible=list.length>fit?list.slice(0,fit-1):list;const more=list.length-visible.length;
        const first=day.endsWith('-01');
        return <div key={day} data-cell={day} className={cx('cal-cell',day.slice(0,7)!==month&&'is-outside',day===today&&'is-today',day<today&&'is-past')}
          onDoubleClick={e=>{if((e.target as HTMLElement).closest('.cal-chip,.cal-more'))return;const slot=slotOn(dateOf(day));create(slot.start,slot.end,false,e.currentTarget);}}>
          <button className="cal-cell-day" aria-label={dayLabel(day,{weekday:'long',month:'long',day:'numeric'})} onClick={()=>showDay(day)}>{first?dayLabel(day,{month:'short',day:'numeric'}):Number(day.slice(8))}</button>
          {visible.map(e=><button key={e.id} className={cx('cal-chip',e.allDay&&'is-allday',selectedId===e.id&&'is-selected')} style={eventStyle(sourceOf(e)?.color)} onClick={ev=>open(e,ev.currentTarget)}>
            {!e.allDay&&<i/>}<span>{e.title||'Untitled'}</span>{!e.allDay&&<time>{shortClock(e.start)}</time>}
          </button>)}
          {draft&&dayKey(draft.start)===day&&<span ref={draftNode} className="cal-chip is-allday cal-draft" style={eventStyle(draftColor)}><span>New event</span></span>}
          {more>0&&<button className="cal-more" onClick={()=>showDay(day)}>{more} more</button>}
        </div>;
      })}
    </div>
  </div>;
});

/** The small month on the left: picks a day for the main view and marks the days in view. */
const MiniMonth=memo(function MiniMonth({anchor,range,busy,onPick}:{anchor:string;range:string[];busy:Set<string>;onPick:(day:string)=>void}){
  const [month,setMonth]=useState(anchor.slice(0,7)+'-01');
  useEffect(()=>setMonth(anchor.slice(0,7)+'-01'),[anchor]);
  const grid=useRef<HTMLDivElement>(null);const keyed=useRef(false);
  const days=viewDays('month',month);const today=todayKey();const from=range[0],to=range[range.length-1];
  useEffect(()=>{if(!keyed.current)return;keyed.current=false;grid.current?.querySelector<HTMLElement>(`[data-day="${anchor}"]`)?.focus();},[anchor,month]);
  function keys(e:React.KeyboardEvent){
    const step:Record<string,number>={ArrowLeft:-1,ArrowRight:1,ArrowUp:-7,ArrowDown:7};
    if(!(e.key in step))return;e.preventDefault();e.stopPropagation();keyed.current=true;onPick(addDays(anchor,step[e.key]));
  }
  return <div className="cal-mini">
    <header><strong>{dayLabel(month,{month:'long',year:'numeric'})}</strong>
      <span className="actions"><IconButton size="xs" label="Previous month" icon={ChevronLeft} onClick={()=>setMonth(shiftAnchor('month',month,-1))}/><IconButton size="xs" label="Next month" icon={ChevronRight} onClick={()=>setMonth(shiftAnchor('month',month,1))}/></span></header>
    <div className="cal-mini-grid" ref={grid} onKeyDown={keys} role="grid" aria-label="Choose a day">
      {days.slice(0,7).map(day=><span key={'h'+day} className="cal-mini-dow" aria-hidden="true">{dayLabel(day,{weekday:'narrow'})}</span>)}
      {days.map(day=><button key={day} data-day={day} tabIndex={day===anchor?0:-1} aria-current={day===today?'date':undefined} aria-label={dayLabel(day,{weekday:'long',month:'long',day:'numeric'})}
        className={cx(day.slice(0,7)!==month.slice(0,7)&&'is-outside',day>=from&&day<=to&&range.length===7&&'in-range',range.length===7&&day===from&&'range-start',range.length===7&&day===to&&'range-end',day===anchor&&'is-anchor',day===today&&'is-today')}
        onClick={()=>onPick(day)}>{Number(day.slice(8))}{busy.has(day)&&<i aria-hidden="true"/>}</button>)}
    </div>
  </div>;
});

/** Calendars grouped by account, each with its colour. Click to show or hide; "Only" isolates one. */
const CalendarList=memo(function CalendarList({accounts,sources,visible,onToggle,onOnly}:{accounts:Account[];sources:CalendarSource[];visible:Set<string>;onToggle:(key:string)=>void;onOnly:(key:string)=>void}){
  const groups=accounts.map(account=>({account,list:sources.filter(s=>s.accountId===account.id)})).filter(g=>g.list.length);
  if(!groups.length)return <p className="cal-rail-note">No calendars yet. Connect an account with Calendar in Settings → Accounts.</p>;
  return <div className="cal-list">{groups.map(({account,list})=><section key={account.id} aria-label={accountLabel(account)}>
    <h3><span className="account-dot" style={{background:account.color}}/>{accountLabel(account)}{account.provider==='demo'&&<small>{account.email}</small>}</h3>
    {list.map(s=>{const on=visible.has(s.key);const alone=on&&visible.size===1;
      return <div key={s.key} className={cx('cal-source',!on&&'is-off')}>
        <button role="checkbox" aria-checked={on} className="cal-source-toggle" style={eventStyle(s.color)} onClick={e=>{if(e.altKey)onOnly(s.key);else onToggle(s.key);}}>
          <span className="cal-swatch">{on&&<Check size={10}/>}</span><span className="cal-source-name">{s.name}</span>
        </button>
        <button className="cal-only" onClick={()=>onOnly(s.key)}>{alone?'Show all':'Only'}</button>
      </div>;})}
  </section>)}</div>;
});

/** The quick editor for a plan drawn on the grid: a title and a calendar, or the full editor. */
function QuickCreate({draft,sources,accounts,onCalendar,onClose,onMore}:{draft:DraftEvent;sources:CalendarSource[];accounts:Account[];onCalendar:(key:string)=>void;onClose:()=>void;onMore:(event:Partial<CalendarEvent>)=>void}){
  const [title,setTitle]=useState('');const [busy,setBusy]=useState(false);const [error,setError]=useState('');
  // The popover stays hidden until it is placed, and a hidden field cannot take focus, so focus once it shows.
  const field=useRef<HTMLInputElement>(null);
  useEffect(()=>{let frame=requestAnimationFrame(()=>{frame=requestAnimationFrame(()=>field.current?.focus({preventScroll:true}));});return ()=>cancelAnimationFrame(frame);},[]);
  const source=sources.find(s=>s.key===draft.calendar);
  const value=():Partial<CalendarEvent>=>({id:uid(),accountId:source?.accountId,calendarId:source?.id,title:title.trim(),start:draft.start,end:draft.end,allDay:draft.allDay,location:'',description:'',guests:[]});
  async function save(){
    if(!title.trim()){setError('Give this event a title.');return;}if(!source)return;
    setBusy(true);setError('');
    try{await invoke('calendar.save',{event:value()});localStorage.setItem(lastCalendarKey,source.key);toast.show({text:`Added to ${source.name}`});onClose();}
    catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  const day=dayKey(draft.start);
  return <div className="cal-quick" onKeyDown={e=>{if(e.key==='Enter'&&!e.nativeEvent.isComposing&&(e.target as HTMLElement).tagName==='INPUT'){e.preventDefault();void save();}}}>
    <input ref={field} className="cal-quick-title" aria-label="Event title" placeholder="New event" aria-invalid={!!error||undefined} value={title} onChange={e=>{setTitle(e.target.value);setError('');}}/>
    <p className="cal-card-line"><Clock size={14}/><span>{dayLabel(day,{weekday:'short',month:'short',day:'numeric'})} · {timeRange(draft)}</span></p>
    <div className="cal-card-line cal-quick-calendar"><span className="cal-swatch is-on" style={eventStyle(source?.color)}/>
      <Select label="Calendar" value={draft.calendar} options={sources.map(s=>[s.key,calendarLabel(s,accounts.find(a=>a.id===s.accountId))] as [string,string])} onChange={key=>{onCalendar(key);localStorage.setItem(lastCalendarKey,key);}}/></div>
    {error&&<p className="field-error" role="alert">{error}</p>}
    <footer><Button variant="text" size="sm" onClick={()=>onMore(value())}>More options</Button><Button variant="primary" size="sm" shortcut="↵" loading={busy} onClick={()=>void save()}>Save</Button></footer>
  </div>;
}

/** An event's details beside it, with edit, delete and the email it came from. */
function EventCard({event,source,account,onEdit,onDelete,onThread,onClose}:{event:CalendarEvent;source?:CalendarSource;account?:Account;onEdit:()=>void;onDelete:()=>void;onThread:(id:string)=>void;onClose:()=>void}){
  const locked=!!event.scheduling;const day=event.allDay?event.start.slice(0,10):dayKey(event.start);
  const host=account?.provider==='google'?'Google Calendar':account?.provider==='microsoft'?'Outlook':'your calendar';
  return <div className="cal-card">
    <header><span className="cal-swatch is-on" style={eventStyle(source?.color)}/><span className="cal-card-calendar">{source?.name??'Calendar'}{accountLabel(account)!==source?.name&&<small>{accountLabel(account)}</small>}</span>
      <span className="actions">{!locked&&<IconButton size="sm" label="Edit event" shortcut="E" icon={SquarePen} onClick={onEdit}/>}{!locked&&<IconButton size="sm" label="Delete event" shortcut="⌫" icon={Trash2} onClick={onDelete}/>}<IconButton size="sm" label="Close" shortcut="Esc" icon={X} onClick={onClose}/></span></header>
    <h3>{event.title||'Untitled'}</h3>
    <p className="cal-card-when">{dayLabel(day,{weekday:'long',month:'long',day:'numeric'})}<span>{timeRange(event)}</span></p>
    {event.location&&<p className="cal-card-line"><MapPin size={14}/><span>{event.location}</span></p>}
    {event.guests.length>0&&<p className="cal-card-line"><Users size={14}/><span>{event.guests.slice(0,3).join(', ')}{event.guests.length>3?` and ${event.guests.length-3} more`:''}</span></p>}
    {event.description&&<p className="cal-card-notes">{event.description}</p>}
    {locked&&<p className="cal-card-note">A meeting with guests. Change it in {host}, so they hear about it.</p>}
    {(event.threadId||event.url)&&<footer>
      {event.threadId&&<Button variant="tinted" size="sm" icon={Mail} onClick={()=>{onClose();onThread(event.threadId!);}}>View email</Button>}
      {event.url&&<Button variant="text" size="sm" iconRight={ExternalLink} onClick={()=>void openUrl(event.url!).catch(e=>toast.show({tone:'error',text:e.message}))}>Open in {host}</Button>}
    </footer>}
  </div>;
}
