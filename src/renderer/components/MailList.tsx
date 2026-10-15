import {useRef} from 'react';
import {Bookmark,Check,Clock,FileText,MoreHorizontal,Paperclip,RotateCcw,Trash2} from '../icons';
import type {Draft,Thread} from '../../shared/types';
import {dateLabel,dueLabel,plain} from '../bridge';
import {Avatar,Badge,Checkbox,Count,IconButton,Keys,Tooltip,cx,useListPresence} from '../ui';
import {ymd} from '../calendarTime';

export type Triage='done'|'later'|'trash'|'spam';
export type RowHandlers={
  activeId?:string;
  cursorId?:string;
  highlight?:Terms;
  selected:Set<string>;
  doneLeft:boolean;
  open:(thread:Thread)=>void;
  /** `range` extends the selection from the last toggled row, `toggle` flips just this one. */
  select:(thread:Thread,how?:'toggle'|'range')=>void;
  triage:(thread:Thread,status:Triage)=>void;
  bookmark:(thread:Thread)=>void;
  /** Bring a thread back from Trash or Spam. */
  restore:(thread:Thread)=>void;
  more:(thread:Thread,anchor:HTMLElement)=>void;
  hover:(thread:Thread,on:boolean)=>void;
};

/** Words from a search query worth marking in rows; `from:` and `subject:` terms only mark their own field. */
export function highlightTerms(query:string){
  const terms={any:[] as string[],from:[] as string[],subject:[] as string[]};
  for(const token of query.match(/(?:[^\s"]+|"[^"]*")+/g)||[]){
    const value=token.replace(/"/g,'').trim();const colon=value.indexOf(':');const key=colon>0?value.slice(0,colon).toLowerCase():'';const term=colon>0?value.slice(colon+1):value;
    if(term.length<2)continue;
    if(!key)terms.any.push(term);else if(key==='from')terms.from.push(term);else if(key==='subject')terms.subject.push(term);
  }
  return terms.any.length||terms.from.length||terms.subject.length?terms:undefined;
}
type Terms=NonNullable<ReturnType<typeof highlightTerms>>;
export function Marked({text,terms}:{text:string;terms?:string[]}){
  if(!terms?.length||!text)return <>{text}</>;
  const pattern=new RegExp('('+terms.map(t=>t.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|')+')','gi');
  return <>{text.split(pattern).map((part,i)=>i%2?<mark key={i} className="match">{part}</mark>:part)}</>;
}

/** A titled card of mail rows. Rows leaving after triage slide out and collapse; rows coming back grow in. */
export function MailSection({title,threads,action,showCount=true,rows}:{title:string;threads:Thread[];action?:React.ReactNode;showCount?:boolean;rows:RowHandlers}){
  const items=useListPresence(threads,thread=>thread.id);
  if(!items.length)return null;
  return <section className="mail-section">
    <header><h2>{title}{showCount&&threads.length>0&&<Count value={threads.length} className="section-count"/>}</h2>{action}</header>
    <div className="mail-group">{items.map(({item,phase,direction})=><MailRow key={item.id} thread={item} rows={rows} phase={phase} direction={direction}/>)}</div>
  </section>;
}

function MailRow({thread:t,rows,phase,direction}:{thread:Thread;rows:RowHandlers;phase?:'enter'|'exit';direction?:string}){
  const m=t.messages.at(-1)!;
  const sent=m.sent?m:undefined;
  const recipient=sent?.to[0]?.replace(/^\s*"?([^"<]+?)"?\s*<.*$/,'$1');
  const who=sent?(recipient?'To '+recipient+(sent.to.length>1?` +${sent.to.length-1}`:''):'No recipients'):m.fromName||m.from;
  const attachments=t.messages.flatMap(message=>message.attachments);
  const today=ymd(new Date());const due=t.dueDate?.slice(0,10);
  const overdue=!!due&&due<today;
  const selected=rows.selected.has(t.id);const selecting=rows.selected.size>0;const exiting=phase==='exit';
  const shift=useRef(false);const hl=rows.highlight;
  const todo=<Tooltip key="todo" content="Todo" shortcut={rows.doneLeft?'→':'←'}><button className="row-action" aria-label={'Move '+t.subject+' to Todo'} onClick={()=>rows.triage(t,'later')}><Clock size={15}/><Keys combo={rows.doneLeft?'→':'←'} size="sm"/></button></Tooltip>;
  const done=<Tooltip key="done" content="Done" shortcut={rows.doneLeft?'←':'→'}><button className="row-action done" aria-label={'Mark '+t.subject+' done'} onClick={()=>rows.triage(t,'done')}><Check size={15}/><Keys combo={rows.doneLeft?'←':'→'} size="sm"/></button></Tooltip>;
  return <div data-thread-id={t.id} className={cx('mail-row',t.unread&&'unread',rows.activeId===t.id&&'active',rows.cursorId===t.id&&'is-cursor',selected&&'checked',selecting&&'selecting',phase&&'row-'+phase,exiting&&'row-exit-'+direction)} inert={exiting||undefined}
    onMouseMove={e=>{if(e.movementX||e.movementY)rows.hover(t,true);}} onMouseLeave={()=>rows.hover(t,false)}>
    <div className="row-leading" onClickCapture={e=>{shift.current=e.shiftKey;}}>
      <Avatar name={recipient||m.fromName||m.from} seed={recipient||m.fromName||m.from}/>
      <Checkbox className="row-checkbox" checked={selected} hideLabel label={'Select '+t.subject} onChange={()=>rows.select(t,shift.current?'range':'toggle')}/>
    </div>
    <button className="row-content" onClick={e=>{if(e.shiftKey)rows.select(t,'range');else if(e.metaKey||e.ctrlKey||selecting)rows.select(t,'toggle');else rows.open(t);}}>
      <span className="row-first">
        <span className="sender"><Marked text={who} terms={hl&&[...hl.any,...hl.from]}/></span>
        {t.messages.length>1&&<span className="thread-count">{t.messages.length}</span>}
        <span className="row-separator">·</span>
        <span className="subject"><Marked text={t.subject} terms={hl&&[...hl.any,...hl.subject]}/></span>
        {t.bookmarked&&<Bookmark size={13} className="row-flag" fill="currentColor"/>}
        {t.dueDate&&t.status==='later'?<span className={cx('row-time',overdue&&'is-overdue',due===today&&'is-due')}>{dueLabel(t.dueDate)}</span>:<span className="row-time">{dateLabel(t.date)}</span>}
      </span>
      <span className="row-second">
        <span className="summary"><Marked text={t.summary} terms={hl?.any}/></span>
        {t.dueDate&&t.status!=='later'&&<Badge tone={overdue?'red':'blue'} className="row-badge">{dueLabel(t.dueDate)}</Badge>}
        {attachments.slice(0,2).map(a=><Badge key={a.id} icon={Paperclip} className="row-badge attachment-badge">{a.name}</Badge>)}
        {attachments.length>2&&<Badge className="row-badge attachment-badge">{attachments.length-2} more</Badge>}
      </span>
    </button>
    <div className="row-actions">
      {t.status==='trash'||t.status==='spam'?<Tooltip content="Restore to Home"><button className="row-action restore" aria-label={'Restore '+t.subject+' to Home'} onClick={()=>rows.restore(t)}><RotateCcw size={14}/><span>Restore</span></button></Tooltip>:<>
      <Tooltip content={t.bookmarked?'Remove bookmark':'Bookmark'} shortcut="B"><button className={cx('row-action',t.bookmarked&&'on')} aria-label={(t.bookmarked?'Remove bookmark from ':'Bookmark ')+t.subject} aria-pressed={t.bookmarked} onClick={()=>rows.bookmark(t)}><Bookmark key={String(t.bookmarked)} className={t.bookmarked?'pop':undefined} size={15} fill={t.bookmarked?'currentColor':'none'}/><Keys combo="B" size="sm"/></button></Tooltip>
      {rows.doneLeft?[done,todo]:[todo,done]}</>}
      <IconButton className="row-action more" label={'More actions for '+t.subject} tooltip={false} icon={MoreHorizontal} onClick={e=>rows.more(t,e.currentTarget)}/>
    </div>
  </div>;
}

function draftRecipients(to:string){
  const list=(to.match(/(?:"[^"]*"|[^,;])+/g)||[]).map(s=>s.trim()).filter(Boolean);
  if(!list.length)return 'No recipients yet';
  const first=list[0].replace(/^\s*"?([^"<]+?)"?\s*<.*$/,'$1');
  return 'To '+first+(list.length>1?` +${list.length-1}`:'');
}
export function DraftList({drafts,open,remove}:{drafts:Draft[];open:(draft:Draft)=>void;remove:(draft:Draft)=>void}){
  const items=useListPresence(drafts,draft=>draft.id);
  return <div className="mail-group drafts-list">{items.map(({item:d,phase,direction})=><div key={d.id} className={cx('draft-row',phase&&'row-'+phase,phase==='exit'&&'row-exit-'+direction)} inert={phase==='exit'||undefined}>
    <button className="draft-open" onClick={()=>open(d)}>
      <span className="draft-avatar"><FileText size={15}/></span>
      <span className="draft-text">
        <span className="row-first"><span className="sender">{draftRecipients(d.to)}</span><span className="row-separator">·</span><span className="subject">{d.subject||'(No subject)'}</span><span className="row-time">{dateLabel(d.updatedAt)}</span></span>
        <span className="row-second"><span className="summary">{plain(d.html).slice(0,140)||'Empty draft'}</span></span>
        {d.sendError&&<em className="danger">{d.sendError}</em>}
      </span>
    </button>
    <IconButton className="draft-delete" label="Delete draft" icon={Trash2} size="sm" onClick={()=>remove(d)}/>
  </div>)}</div>;
}
