import {useEffect,useState} from 'react';
import {CalendarDays,Check,ChevronLeft,ChevronRight,Clock,ExternalLink,MapPin,Plus,Trash2,Users,X} from './icons';
import type {Account,CalendarEvent} from '../shared/types';
import {dateLabel,invoke,openUrl,uid} from './bridge';
import {Button,Checkbox,Dialog,EmptyState,Field,IconButton,Notice,Select,confirmAction,cx} from './ui';

export function EventEditor({event,accounts,onClose,notify}:{event:Partial<CalendarEvent>;accounts:Account[];onClose:()=>void;notify:(s:string)=>void}){
 const now=new Date();now.setMinutes(0,0,0);now.setHours(now.getHours()+1);
 const [value,setValue]=useState<CalendarEvent>({id:event.id||uid(),accountId:event.accountId||accounts[0]?.id,calendarId:'primary',title:'',start:now.toISOString(),end:new Date(+now+3600000).toISOString(),allDay:false,location:'',description:'',guests:[],...event});const [calendars,setCalendars]=useState<{id:string;name:string;accountId:string}[]>([]);const [busy,setBusy]=useState(false);const [error,setError]=useState('');
 const [open,setOpen]=useState(true);
 useEffect(()=>{invoke<typeof calendars>('calendar.list',{accountId:value.accountId}).then(list=>{setCalendars(list);if(list.length)setValue(current=>list.some(c=>c.id===current.calendarId)?current:{...current,calendarId:list[0].id});}).catch(e=>setError(e.message));},[value.accountId]);
 function close(){setOpen(false);setTimeout(onClose,120);}
 function local(iso:string,allDay=false){if(allDay)return iso.slice(0,10);const d=new Date(iso.length===10?iso+'T00:00:00':iso);return new Date(+d-d.getTimezoneOffset()*60000).toISOString().slice(0,16);}
 async function save(){setBusy(true);try{if(!value.title.trim())throw new Error('Give this event a title.');if(+new Date(value.end)<=+new Date(value.start))throw new Error('End time must be after start time.');await invoke('calendar.save',{event:value});notify('Calendar updated');close();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
 return <Dialog open={open} onClose={close} label="Calendar event" className="event-editor">
  <header><div className="title-with-icon"><CalendarDays size={19}/><strong>{event.id?'Event details':'Add to calendar'}</strong></div><IconButton label="Close event" shortcut="Esc" icon={X} onClick={close}/></header>
  <div className="event-fields">
   <input className="event-title" aria-label="Event title" placeholder="Event title" autoFocus value={value.title} onChange={e=>setValue({...value,title:e.target.value})}/>
   <div className="field-grid">
    <Field label="Account"><Select variant="field" label="Account" value={value.accountId} options={accounts.map(a=>[a.id,a.email] as [string,string])} onChange={accountId=>setValue({...value,accountId,calendarId:'primary'})}/></Field>
    <Field label="Calendar"><Select variant="field" label="Calendar" value={value.calendarId} options={calendars.length?calendars.map(c=>[c.id,c.name] as [string,string]):[['primary','Primary calendar']]} onChange={calendarId=>setValue({...value,calendarId})}/></Field>
   </div>
   <div className="field-grid">
    <Field label="Starts"><input type={value.allDay?'date':'datetime-local'} value={local(value.start,value.allDay)} onChange={e=>{if(e.target.value)setValue({...value,start:value.allDay?e.target.value:new Date(e.target.value).toISOString()});}}/></Field>
    <Field label="Ends"><input type={value.allDay?'date':'datetime-local'} value={local(value.end,value.allDay)} onChange={e=>{if(e.target.value)setValue({...value,end:value.allDay?e.target.value:new Date(e.target.value).toISOString()});}}/></Field>
   </div>
   <Checkbox className="all-day" label="All-day event" checked={value.allDay} onChange={allDay=>setValue({...value,allDay})}/>
   <Field label="Location"><input value={value.location} placeholder="Add a place or meeting link" onChange={e=>setValue({...value,location:e.target.value})}/></Field>
   <Field label="Guests"><input value={value.guests.join(', ')} placeholder="Email addresses, separated by commas" onChange={e=>setValue({...value,guests:e.target.value.split(',').map(x=>x.trim())})}/></Field>
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
 return <div className="calendar-page"><div className="page-heading"><h2>Calendar</h2><Button variant="pill" icon={Plus} onClick={()=>edit({accountId:accountId==='all'?accounts[0]?.id:accountId})}>New event</Button></div>
  <div className="calendar-layout">
   <div className="calendar-month"><header><h2 key={month.toDateString()} className="month-title">{month.toLocaleDateString([],{month:'long',year:'numeric'})}</h2><div className="actions"><IconButton label="Previous month" icon={ChevronLeft} iconSize={17} onClick={()=>shift(-1)}/><Button variant="secondary" size="sm" className="today-button" onClick={()=>{setDirection(0);setMonth(new Date());setSelected(new Date().toDateString());}}>Today</Button><IconButton label="Next month" icon={ChevronRight} iconSize={17} onClick={()=>shift(1)}/></div></header>
    <div className={cx('calendar-grid',direction>0&&'from-right',direction<0&&'from-left')} key={month.getFullYear()+'-'+month.getMonth()}>{['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(d=><span className="day-name" key={d}>{d}</span>)}{Array.from({length:first.getDay()},(_,i)=><span key={'blank'+i}/>)}{Array.from({length:days},(_,i)=>{const date=new Date(month.getFullYear(),month.getMonth(),i+1);const n=scoped.filter(e=>dayOf(e)===date.toDateString()).length;return <button key={i} aria-pressed={selected===date.toDateString()} aria-label={date.toLocaleDateString([],{weekday:'long',month:'long',day:'numeric'})+(n?`, ${n} plan${n===1?'':'s'}`:'')} className={cx(selected===date.toDateString()&&'selected-day',date.toDateString()===new Date().toDateString()&&'today')} onClick={()=>setSelected(date.toDateString())}><span>{i+1}</span><div className="event-dots">{n>0&&<i/>}{n>1&&<i/>}{n>2&&<i/>}</div></button>;})}</div>
    <div className="calendar-key"><i/>Plans from your mail & calendar</div>
   </div>
   <div className="day-agenda" key={selected}><p className="eyebrow">{new Date(selected).toLocaleDateString([],{weekday:'long',month:'long',day:'numeric'})}</p>{dayEvents.length?dayEvents.map(e=><div className="agenda-event" key={e.id}><span className="event-time">{e.allDay?'All day':new Date(e.start).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})}</span><button className="event-detail-button" onClick={()=>edit(e)}><strong>{e.title}</strong><span><Clock size={12}/>{e.allDay?'All day':dateLabel(e.end)}</span>{e.location&&<span><MapPin size={12}/>{e.location}</span>}{e.guests.length>0&&<span><Users size={12}/>{e.guests.length} guests</span>}</button>{e.threadId&&<Button variant="text" size="sm" className="accent" onClick={()=>onThread(e.threadId!)}>View email</Button>}</div>)
    :<EmptyState icon={CalendarDays} title="A little breathing room." detail="No plans here yet." action={<Button variant="secondary" size="sm" icon={Plus} onClick={()=>{const start=new Date(selected);start.setHours(10);edit({start:start.toISOString(),end:new Date(+start+3600000).toISOString()});}}>Add a plan</Button>}/>}</div>
  </div>
 </div>;
}
