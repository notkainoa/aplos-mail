import {useEffect,useRef,useState} from 'react';
import {CalendarDays,Check,ChevronLeft,ChevronRight,Clock,ExternalLink,MapPin,Plus,Trash2,Users,X} from './icons';
import type {Account,CalendarEvent} from '../shared/types';
import {invoke,openUrl,uid} from './bridge';
import {Button,Checkbox,Dialog,EmptyState,Field,IconButton,Notice,Select,confirmAction,cx} from './ui';
import {addDays,clock,dayKey,localInput,moveStart,parseGuests,setAllDay as withAllDay,slotOn,timeRange} from './calendarTime';

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
  <header><div className="title-with-icon"><CalendarDays size={19}/><strong>{event.id?'Event details':'Add to calendar'}</strong></div><IconButton label="Close event" shortcut="Esc" icon={X} onClick={close}/></header>
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

export function Calendar({events,accounts,accountId,edit,onThread}:{events:CalendarEvent[];accounts:Account[];accountId:string;edit:(event:Partial<CalendarEvent>)=>void;onThread:(id:string)=>void}){
 const [month,setMonth]=useState(new Date());const [selected,setSelected]=useState(new Date().toDateString());const [direction,setDirection]=useState(0);
 const first=new Date(month.getFullYear(),month.getMonth(),1);const days=new Date(month.getFullYear(),month.getMonth()+1,0).getDate();
 const scoped=events.filter(e=>accountId==='all'||e.accountId===accountId);
 const dayOf=(e:CalendarEvent)=>new Date(e.allDay?e.start.slice(0,10)+'T00:00:00':e.start).toDateString();
 const dayEvents=scoped.filter(e=>dayOf(e)===selected).sort((a,b)=>a.start.localeCompare(b.start));
 function shift(delta:number){setDirection(delta);setMonth(new Date(month.getFullYear(),month.getMonth()+delta,1));}
 const newOn=(day:Date)=>edit({accountId:accountId==='all'?accounts[0]?.id:accountId,...slotOn(day)});
 const grid=useRef<HTMLDivElement>(null);const focusDay=useRef(false);
 function moveTo(date:Date){focusDay.current=true;setSelected(date.toDateString());
  if(date.getMonth()!==month.getMonth()||date.getFullYear()!==month.getFullYear()){setDirection(date>month?1:-1);setMonth(new Date(date.getFullYear(),date.getMonth(),1));}}
 useEffect(()=>{if(!focusDay.current)return;focusDay.current=false;grid.current?.querySelector<HTMLElement>(`[data-day="${selected}"]`)?.focus();},[selected,month]);
 function gridKeys(event:React.KeyboardEvent){
  const date=new Date(selected);const step:Record<string,number>={ArrowLeft:-1,ArrowRight:1,ArrowUp:-7,ArrowDown:7};
  if(event.key in step)date.setDate(date.getDate()+step[event.key]);
  else if(event.key==='Home')date.setDate(date.getDate()-date.getDay());
  else if(event.key==='End')date.setDate(date.getDate()+6-date.getDay());
  else if(event.key==='PageUp'||event.key==='PageDown')date.setMonth(date.getMonth()+(event.key==='PageUp'?-1:1));
  else return;
  event.preventDefault();event.stopPropagation();moveTo(date);
 }
 const inMonth=new Date(selected).getMonth()===month.getMonth()&&new Date(selected).getFullYear()===month.getFullYear();
 return <div className="calendar-page"><div className="page-heading"><h2>Calendar</h2><Button variant="pill" icon={Plus} onClick={()=>newOn(new Date(selected))}>New event</Button></div>
  <div className="calendar-layout">
   <div className="calendar-month"><header><h2 key={month.toDateString()} className="month-title">{month.toLocaleDateString([],{month:'long',year:'numeric'})}</h2><div className="actions"><IconButton label="Previous month" icon={ChevronLeft} iconSize={17} onClick={()=>shift(-1)}/><Button variant="secondary" size="sm" className="today-button" onClick={()=>{setDirection(0);setMonth(new Date());setSelected(new Date().toDateString());}}>Today</Button><IconButton label="Next month" icon={ChevronRight} iconSize={17} onClick={()=>shift(1)}/></div></header>
    <div ref={grid} className={cx('calendar-grid',direction>0&&'from-right',direction<0&&'from-left')} key={month.getFullYear()+'-'+month.getMonth()} onKeyDown={gridKeys}>{['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(d=><span className="day-name" key={d}>{d}</span>)}{Array.from({length:first.getDay()},(_,i)=><span key={'blank'+i}/>)}{Array.from({length:days},(_,i)=>{const date=new Date(month.getFullYear(),month.getMonth(),i+1);const key=date.toDateString();const n=scoped.filter(e=>dayOf(e)===key).length;const isSelected=selected===key;return <button key={i} data-day={key} tabIndex={isSelected||(!inMonth&&i===0)?0:-1} aria-pressed={isSelected} aria-label={date.toLocaleDateString([],{weekday:'long',month:'long',day:'numeric'})+(n?`, ${n} plan${n===1?'':'s'}`:'')} className={cx(isSelected&&'selected-day',key===new Date().toDateString()&&'today')} onClick={()=>setSelected(key)} onDoubleClick={()=>newOn(date)}><span>{i+1}</span><div className="event-dots">{n>0&&<i/>}{n>1&&<i/>}{n>2&&<i/>}</div></button>;})}</div>
    <div className="calendar-key"><i/>Plans from your mail & calendar<span className="calendar-hint">Double-click a day to add</span></div>
   </div>
   <div className="day-agenda" key={selected}><p className="eyebrow">{new Date(selected).toLocaleDateString([],{weekday:'long',month:'long',day:'numeric'})}</p>{dayEvents.length?dayEvents.map(e=><div className="agenda-event" key={e.id}><span className="event-time">{e.allDay?'All day':clock(e.start)}</span><button className="event-detail-button" onClick={()=>edit(e)}><strong>{e.title}</strong><span><Clock size={12}/>{timeRange(e)}</span>{e.location&&<span><MapPin size={12}/>{e.location}</span>}{e.guests.length>0&&<span><Users size={12}/>{e.guests.length===1?e.guests[0]:`${e.guests.length} guests`}</span>}</button>{e.threadId&&<Button variant="text" size="sm" className="accent" onClick={()=>onThread(e.threadId!)}>View email</Button>}</div>)
    :<EmptyState icon={CalendarDays} title="A little breathing room." detail="No plans here yet." action={<Button variant="secondary" size="sm" icon={Plus} onClick={()=>newOn(new Date(selected))}>Add a plan</Button>}/>}</div>
  </div>
 </div>;
}
