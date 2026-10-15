import {Bookmark,Check,Clock,FileText,MoreHorizontal,Paperclip,Trash2} from '../icons';
import type {Draft,Thread} from '../../shared/types';
import {dateLabel,dueLabel,plain} from '../bridge';
import {Avatar,Badge,Checkbox,Count,IconButton,Keys,Tooltip,cx,useListPresence} from '../ui';

export type Triage='done'|'later'|'trash'|'spam';
export type RowHandlers={
  activeId?:string;
  selected:Set<string>;
  doneLeft:boolean;
  open:(thread:Thread)=>void;
  select:(thread:Thread)=>void;
  triage:(thread:Thread,status:Triage)=>void;
  bookmark:(thread:Thread)=>void;
  more:(thread:Thread,anchor:HTMLElement)=>void;
  hover:(thread:Thread,on:boolean)=>void;
};

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
  const m=t.messages.at(-1)!;const attachments=t.messages.flatMap(message=>message.attachments);
  const overdue=!!t.dueDate&&t.dueDate<new Date().toISOString().slice(0,10);
  const selected=rows.selected.has(t.id);const selecting=rows.selected.size>0;const exiting=phase==='exit';
  const todo=<Tooltip key="todo" content="Todo" shortcut={rows.doneLeft?'→':'←'}><button className="row-action" aria-label={'Move '+t.subject+' to Todo'} onClick={()=>rows.triage(t,'later')}><Clock size={15}/><Keys combo={rows.doneLeft?'→':'←'} size="sm"/></button></Tooltip>;
  const done=<Tooltip key="done" content="Done" shortcut={rows.doneLeft?'←':'→'}><button className="row-action done" aria-label={'Mark '+t.subject+' done'} onClick={()=>rows.triage(t,'done')}><Check size={15}/><Keys combo={rows.doneLeft?'←':'→'} size="sm"/></button></Tooltip>;
  return <div className={cx('mail-row',t.unread&&'unread',rows.activeId===t.id&&'active',selected&&'checked',selecting&&'selecting',phase&&'row-'+phase,exiting&&'row-exit-'+direction)} inert={exiting||undefined}
    onMouseEnter={()=>rows.hover(t,true)} onMouseLeave={()=>rows.hover(t,false)}>
    <div className="row-leading">
      <Avatar name={m.fromName||m.from} seed={m.fromName||m.from}/>
      <Checkbox className="row-checkbox" checked={selected} hideLabel label={'Select '+t.subject} onChange={()=>rows.select(t)}/>
    </div>
    <button className="row-content" onClick={()=>rows.open(t)}>
      <span className="row-first">
        <span className="sender">{m.fromName}</span>
        {t.messages.length>1&&<span className="thread-count">{t.messages.length}</span>}
        <span className="row-separator">·</span>
        <span className="subject">{t.subject}</span>
        {t.bookmarked&&<Bookmark size={13} className="row-flag" fill="currentColor"/>}
        <span className="row-time">{t.dueDate&&t.status==='later'?dueLabel(t.dueDate):dateLabel(t.date)}</span>
      </span>
      <span className="row-second">
        <span className="summary">{t.summary}</span>
        {t.dueDate&&t.status!=='later'&&<Badge tone={overdue?'red':'blue'} className="row-badge">{dueLabel(t.dueDate)}</Badge>}
        {attachments.slice(0,2).map(a=><Badge key={a.id} icon={Paperclip} className="row-badge attachment-badge">{a.name}</Badge>)}
        {attachments.length>2&&<Badge className="row-badge attachment-badge">{attachments.length-2} more</Badge>}
      </span>
    </button>
    <div className="row-actions">
      <Tooltip content={t.bookmarked?'Remove bookmark':'Bookmark'} shortcut="B"><button className={cx('row-action',t.bookmarked&&'on')} aria-label={(t.bookmarked?'Remove bookmark from ':'Bookmark ')+t.subject} aria-pressed={t.bookmarked} onClick={()=>rows.bookmark(t)}><Bookmark key={String(t.bookmarked)} className={t.bookmarked?'pop':undefined} size={15} fill={t.bookmarked?'currentColor':'none'}/><Keys combo="B" size="sm"/></button></Tooltip>
      {rows.doneLeft?[done,todo]:[todo,done]}
      <IconButton className="row-action more" label={'More actions for '+t.subject} tooltip={false} icon={MoreHorizontal} onClick={e=>rows.more(t,e.currentTarget)}/>
    </div>
  </div>;
}

export function DraftList({drafts,open,remove}:{drafts:Draft[];open:(draft:Draft)=>void;remove:(draft:Draft)=>void}){
  const items=useListPresence(drafts,draft=>draft.id);
  return <div className="mail-group drafts-list">{items.map(({item:d,phase,direction})=><div key={d.id} className={cx('draft-row',phase&&'row-'+phase,phase==='exit'&&'row-exit-'+direction)} inert={phase==='exit'||undefined}>
    <button className="draft-open" onClick={()=>open(d)}>
      <span className="draft-avatar"><FileText size={15}/></span>
      <span className="draft-text">
        <span className="row-first"><span className="sender">{d.to||'No recipients yet'}</span><span className="row-separator">·</span><span className="subject">{d.subject||'(No subject)'}</span><span className="row-time">{dateLabel(d.updatedAt)}</span></span>
        <span className="row-second"><span className="summary">{plain(d.html).slice(0,140)||'Empty draft'}</span></span>
        {d.sendError&&<em className="danger">{d.sendError}</em>}
      </span>
    </button>
    <IconButton className="draft-delete" label="Delete draft" icon={Trash2} size="sm" onClick={()=>remove(d)}/>
  </div>)}</div>;
}
