import {useMemo,useState} from 'react';
import {CalendarDays,Check,Clock,MapPin,Plus,X} from './icons';
import type {Account,CalendarEvent} from '../shared/types';
import {invoke,uid} from './bridge';
import {Avatar,Button,Checkbox,IconButton,Notice,Select,cx} from './ui';
import {addDays,clock,dayKey,localInput,moveStart,setAllDay,timeRange} from './calendarTime';
import type {Contact} from './Compose';

const rowHeight=26;const hours=9;
/** Demo accounts keep a local calendar; connected accounts save to their primary host calendar. */
export const calendarFor=(a:Account)=>a.provider!=='demo'&&a.calendarConnected?'primary':`demo-${a.id}`;
const dayOf=(iso:string,allDay:boolean)=>new Date(allDay?iso.slice(0,10)+'T00:00:00':iso);
const longDay=(iso:string,allDay:boolean)=>dayOf(iso,allDay).toLocaleDateString([],{weekday:'short',month:'short',day:'numeric'});
const hourLabel=(h:number)=>new Date(2000,0,1,h).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'});
const validGuest=(x:string)=>/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x);

type Props={proposal:Partial<CalendarEvent>;accounts:Account[];accountId:string;events:CalendarEvent[];contacts:Contact[];savedId?:string;
  onSaved:(id:string)=>void;notify:(text:string)=>void;onEdit:(event:Partial<CalendarEvent>)=>void;onCalendar:()=>void};

/** An event Ask prepared. Nothing is written until the user presses the button. */
export function AskEvent({proposal,accounts,accountId,events,contacts,savedId,onSaved,notify,onEdit,onCalendar}:Props){
  const choices=accounts.filter(a=>a.provider==='demo'||a.calendarConnected);const options=choices.length?choices:accounts;
  const first=options.find(a=>a.id===accountId)??options[0];
  const [value,setValue]=useState<CalendarEvent>(()=>({id:uid(),accountId:first?.id??'',calendarId:first?calendarFor(first):'primary',title:'',start:'',end:'',allDay:false,location:'',description:'',guests:[],...proposal}));
  const [editingTime,setEditingTime]=useState(false);const [guest,setGuest]=useState('');const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [listId]=useState(()=>'guests-'+uid());
  const names=useMemo(()=>new Map(contacts.map(c=>[c.email.toLowerCase(),c.name])),[contacts]);
  const me=accounts.find(a=>a.id===value.accountId);
  const backwards=+dayOf(value.end,value.allDay)<=+dayOf(value.start,value.allDay);
  const saved=!!savedId;
  // The day around the proposed slot, with anything that overlaps it marked.
  const day=dayKey(value.start);
  const sameDay=events.filter(e=>e.id!==savedId&&e.id!==value.id&&(e.allDay?e.start.slice(0,10)<=day&&e.end.slice(0,10)>day:dayKey(e.start)===day));
  const allDay=sameDay.filter(e=>e.allDay);const timed=sameDay.filter(e=>!e.allDay).sort((a,b)=>a.start.localeCompare(b.start));
  const startHour=value.allDay?8:new Date(value.start).getHours();const top=Math.max(0,Math.min(24-hours,startHour-2));
  const overlaps=value.allDay?[]:timed.filter(e=>+new Date(e.start)<+new Date(value.end)&&+new Date(e.end)>+new Date(value.start));
  const place=(start:string,end:string)=>{const s=new Date(start),e=new Date(end);const base=new Date(s);base.setHours(top,0,0,0);
    const from=(+s-+base)/3600000,to=Math.min(hours,(+e-+base)/3600000);if(to<=0||from>=hours)return;
    return {top:Math.max(0,from)*rowHeight,height:Math.max(18,(to-Math.max(0,from))*rowHeight-2)};};
  const slot=value.allDay?undefined:place(value.start,value.end);
  function addGuest(){const email=guest.trim();if(!email)return;if(!validGuest(email)){setError(`“${email}” isn’t an email address.`);return;}setError('');setValue(v=>v.guests.includes(email)?v:{...v,guests:[...v.guests,email]});setGuest('');}
  async function save(){
    if(!value.title.trim()){setError('Give this event a title.');return;}if(backwards){setError('End time must be after start time.');return;}
    setBusy(true);setError('');
    try{const result=await invoke<CalendarEvent>('calendar.save',{event:value});onSaved(result.id);notify(value.guests.length?`Added to your calendar with ${value.guests.length} guest${value.guests.length===1?'':'s'}`:'Added to your calendar');}
    catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  return <div className={cx('ask-event',saved&&'is-saved')}>
    <header><CalendarDays size={15}/><span>{saved?'Added to your calendar':'New event'}</span>{saved&&<Check size={14} className="ask-event-check"/>}</header>
    <input className="ask-event-title" aria-label="Event title" placeholder="Event title" value={value.title} disabled={saved} onChange={e=>setValue({...value,title:e.target.value})}/>
    <div className="ask-event-grid">
      <div className="ask-event-fields">
        <div className="ask-event-row"><Clock size={15}/>
          {editingTime&&!saved?<div className="ask-event-times">
            <input type={value.allDay?'date':'datetime-local'} aria-label="Starts" value={value.allDay?dayKey(value.start):localInput(value.start)} onChange={e=>{if(e.target.value)setValue(v=>moveStart(v,e.target.value));}}/>
            <input type={value.allDay?'date':'datetime-local'} aria-label="Ends" aria-invalid={backwards||undefined} value={value.allDay?addDays(value.end.slice(0,10),-1):localInput(value.end)} onChange={e=>{const next=e.target.value;if(next)setValue(v=>({...v,end:v.allDay?addDays(next,1):new Date(next).toISOString()}));}}/>
            <Checkbox label="All day" checked={value.allDay} onChange={on=>setValue(v=>setAllDay(v,on))}/>
          </div>
          :<button className="ask-event-when" disabled={saved} onClick={()=>setEditingTime(true)}><strong>{longDay(value.start,value.allDay)}</strong><span>·</span>{timeRange(value)}</button>}
        </div>
        <label className="ask-event-row"><MapPin size={15}/><input aria-label="Location" placeholder="No location" value={value.location} disabled={saved} onChange={e=>setValue({...value,location:e.target.value})}/></label>
        <div className="ask-event-row"><CalendarDays size={15}/><Select variant="field" label="Calendar account" disabled={saved} value={value.accountId} options={options.map(a=>[a.id,a.email] as [string,string])} onChange={id=>{const a=accounts.find(x=>x.id===id);if(a)setValue({...value,accountId:id,calendarId:calendarFor(a)});}}/></div>
        <ul className="ask-event-people">
          <li><Avatar name={me?.name||'Me'} color={me?.color} size={26}/><span><strong>Me</strong><small>organizer</small></span></li>
          {value.guests.map(g=>{const name=names.get(g.toLowerCase());return <li key={g}><Avatar name={name||g} size={26}/><span><strong>{name||g}</strong>{name&&<small>{g}</small>}</span>{!saved&&<IconButton size="xs" label={'Remove '+(name||g)} icon={X} onClick={()=>setValue(v=>({...v,guests:v.guests.filter(x=>x!==g)}))}/>}</li>;})}
          {!saved&&<li className="ask-event-add"><span className="ask-event-plus"><Plus size={13}/></span><input list={listId} aria-label="Add a guest" placeholder="Add guest" value={guest} onChange={e=>setGuest(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();e.stopPropagation();addGuest();}}} onBlur={()=>{if(guest.trim())addGuest();}}/>
            <datalist id={listId}>{contacts.slice(0,40).map(c=><option key={c.email} value={c.email}>{c.name}</option>)}</datalist></li>}
        </ul>
      </div>
      <div className="ask-day" aria-label={`Your plans on ${longDay(value.start,value.allDay)}`}>
        {allDay.map(e=><p key={e.id} className="ask-day-allday">All day: {e.title}</p>)}
        {value.allDay?<p className="ask-day-note">{timed.length?`${timed.length} other plan${timed.length===1?'':'s'} that day`:'Nothing else that day'}</p>
        :<><div className={cx('ask-day-grid',overlaps.length>0&&'has-conflict')} style={{height:hours*rowHeight}}>
          {Array.from({length:hours},(_,i)=><span key={i} className="ask-day-hour" style={{top:i*rowHeight}}>{hourLabel(top+i)}</span>)}
          {timed.map(e=>{const box=place(e.start,e.end);return box&&<span key={e.id} className={cx('ask-day-event',overlaps.includes(e)&&'is-conflict')} style={box}>{e.title}<small>{clock(e.start)}</small></span>;})}
          {slot&&<span className="ask-day-event is-new" style={slot}>{value.title||'New event'}</span>}
        </div>
        <p className={cx('ask-day-note',overlaps.length>0&&'is-conflict')}>{overlaps.length?`Overlaps ${overlaps.map(e=>e.title).join(', ')}`:'You’re free then'}</p></>}
      </div>
    </div>
    {error&&<Notice>{error}</Notice>}
    <footer>
      {saved?<><span className="muted small">Saved to {me?.email}</span><Button variant="secondary" size="sm" icon={CalendarDays} onClick={onCalendar}>Open Calendar</Button></>
      :<><Button variant="text" size="sm" onClick={()=>onEdit(value)}>Edit details</Button><Button variant="primary" size="sm" icon={Check} loading={busy} onClick={()=>void save()}>{value.guests.length?'Add with guests':'Add to calendar'}</Button></>}
    </footer>
  </div>;
}
