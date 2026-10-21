import {memo,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {ArrowUpRight,Bookmark,Check,CircleCheck,Clock,FileText,MoreHorizontal,Paperclip,RotateCcw,Trash2} from '../icons';
import type {Draft,Thread} from '../../shared/types';
import {shortDue,shortSender} from '../../shared/mailbox';
import {dateLabel,dueLabel,plain} from '../bridge';
import {Avatar,Badge,Button,Checkbox,Count,IconButton,cx,reducedMotion,useListPresence,useSwipe,type SwipeSide} from '../ui';
import {ymd} from '../calendarTime';

export type Triage='done'|'later'|'trash'|'spam';
/** Row callbacks. Pass a stable object (see `useHandlers`) so unchanged rows skip re-rendering. */
export type RowActions={
  open:(thread:Thread)=>void;
  /** `range` extends the selection from the last toggled row, `toggle` flips just this one. */
  select:(thread:Thread,how?:'toggle'|'range')=>void;
  triage:(thread:Thread,status:Triage)=>void;
  bookmark:(thread:Thread)=>void;
  /** Bring a thread back from Trash or Spam. */
  restore:(thread:Thread)=>void;
  more:(thread:Thread,anchor:HTMLElement)=>void;
  /** Make this the one focused row. Without it a click opens the thread. */
  focus?:(thread:Thread)=>void;
  hover?:(thread:Thread,on:boolean)=>void;
};
export type RowHandlers={
  activeId?:string;
  /** The focused row, drawn as a card. */
  cursorId?:string;
  /** A card just acted on; it stays a card until it has left the list. */
  departingId?:string;
  /** Each thread's position in the whole on-screen order; rows expose it as `--i` for distance styling. */
  indexOf?:Map<string,number>;
  highlight?:Terms;
  selected:Set<string>;
  doneLeft:boolean;
  /** Rows can be dragged or swiped sideways to triage. */
  swipe:boolean;
  actions:RowActions;
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

/** A titled group of mail rows. Rows leaving after triage slide out and collapse; rows coming back grow in. */
const noThreads:Thread[]=[];
// Long enough for a focused card to slide away and close its gap.
const exitMs=280;
export function MailSection({title,threads,action,showCount=true,rows,plain}: {title:string;threads:Thread[];action?:React.ReactNode;showCount?:boolean;rows:RowHandlers;plain?:boolean}){
  const items=useListPresence(threads.length>200?noThreads:threads,thread=>thread.id,exitMs);
  if(!threads.length&&!items.length)return null;
  return <section className={cx('mail-section',plain&&'is-plain')}>
    {!plain&&<header><h2>{title}{showCount&&threads.length>0&&<Count value={threads.length} className="section-count"/>}</h2>{action}</header>}
    {threads.length>200?<WindowedMailRows threads={threads} rows={rows}/>:<div className="mail-group">{presentRows(items,rows)}</div>}
  </section>;
}

function PresentMailRows({threads,rows}:{threads:Thread[];rows:RowHandlers}) {
  const items=useListPresence(threads,thread=>thread.id,exitMs);
  return <>{presentRows(items,rows)}</>;
}
const presentRows=(items:Array<{item:Thread;phase?:'enter'|'exit';direction?:string}>,rows:RowHandlers)=>items.map(({item,phase,direction})=><MailRow key={item.id} thread={item} actions={rows.actions} phase={phase} direction={direction} index={rows.indexOf?.get(item.id)}
  active={rows.activeId===item.id} cursor={rows.cursorId===item.id||rows.departingId===item.id} selected={rows.selected.has(item.id)} selecting={rows.selected.size>0} doneLeft={rows.doneLeft} swipe={rows.swipe} highlight={rows.highlight}/>);

/**
 * Fixed-height rows keep the scrollbar and keyboard order while only nearby rows mount. The one focused card is
 * taller; its measured extra height is added after its index so offsets and spacers stay exact.
 */
function WindowedMailRows({threads,rows}:{threads:Thread[];rows:RowHandlers}) {
  const group=useRef<HTMLDivElement>(null),measure=useRef<()=>void>(()=>{});
  const focusAt=rows.cursorId?threads.findIndex(t=>t.id===rows.cursorId):-1;
  const geometry=useRef({focus:focusAt,extra:0});geometry.current.focus=focusAt;
  const [range,setRange]=useState({start:0,end:40,height:40,extra:0});
  const top=(index:number,height:number,extra:number)=>index*height+(focusAt>=0&&index>focusAt?extra:0);
  useLayoutEffect(()=>{
    const node=group.current,scroll=node?.closest<HTMLElement>('.mail-content');if(!node||!scroll)return;
    let frame=0;
    const height=parseFloat(getComputedStyle(node).getPropertyValue('--row-height'))||40;
    const update=()=>{
      const {focus,extra}=geometry.current;const x=focus>=0?extra:0;
      const offset=scroll.getBoundingClientRect().top-node.getBoundingClientRect().top;
      let first=Math.floor(offset/height);if(focus>=0&&first>focus)first=Math.max(focus+1,Math.floor((offset-x)/height));
      const count=Math.ceil(scroll.clientHeight/height)+16;
      const start=Math.max(0,Math.min(threads.length-count,first-8)),end=Math.min(threads.length,start+count);
      setRange(old=>old.start===start&&old.end===end&&old.height===height&&old.extra===extra?old:{start,end,height,extra});
    };
    const schedule=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(update);};
    measure.current=update;update();scroll.addEventListener('scroll',schedule,{passive:true});
    const resize=new ResizeObserver(schedule);resize.observe(scroll);
    return()=>{cancelAnimationFrame(frame);resize.disconnect();scroll.removeEventListener('scroll',schedule);measure.current=()=>{};};
  },[threads.length]);
  // The card's body keeps its natural height while the row animates, so it measures the settled size.
  useLayoutEffect(()=>{
    const card=group.current?.querySelector<HTMLElement>('.mail-row.is-focus:not(.row-exit) > .row-body');if(!card)return;
    const style=getComputedStyle(card.parentElement!);
    const extra=Math.max(0,card.offsetHeight+parseFloat(style.paddingTop)+parseFloat(style.paddingBottom)-range.height);
    if(Math.abs(extra-geometry.current.extra)>1){geometry.current.extra=extra;measure.current();}
  });
  useLayoutEffect(()=>{
    if(focusAt<0)return;measure.current();
    if(focusAt>=range.start&&focusAt<range.end)return;
    const node=group.current,scroll=node?.closest<HTMLElement>('.mail-content');if(!node||!scroll)return;
    scroll.scrollTop+=node.getBoundingClientRect().top-scroll.getBoundingClientRect().top+focusAt*range.height-scroll.clientHeight/3;
    measure.current();
  },[rows.cursorId]);
  const visible=useMemo(()=>threads.slice(range.start,range.end),[threads,range.start,range.end]);
  const before=top(range.start,range.height,range.extra),after=Math.max(0,threads.length-range.end)*range.height+(focusAt>=range.end?range.extra:0);
  return <div className="mail-group" ref={group} data-virtual-count={threads.length}>
    <div aria-hidden="true" style={{height:before}}/>
    <PresentMailRows key={range.start} threads={visible} rows={rows}/>
    <div aria-hidden="true" style={{height:after}}/>
  </div>;
}

let lastClick:{thread:Thread;at:number}|null=null;
/** Keeps a clicked row under the pointer while cards above it resize, then brings its card fully into view. */
function holdStill(row:HTMLElement|null){
  const scroller=row?.closest<HTMLElement>('.mail-content');if(!row||!scroller||reducedMotion())return;
  const top=row.getBoundingClientRect().top,end=performance.now()+260;
  const step=()=>{
    const drift=row.getBoundingClientRect().top-top;if(Math.abs(drift)>.5)scroller.scrollTop+=drift;
    if(performance.now()<end){requestAnimationFrame(step);return;}
    const box=row.getBoundingClientRect(),view=scroller.getBoundingClientRect();
    if(box.bottom>view.bottom-24)scroller.scrollBy({top:box.bottom-view.bottom+24,behavior:'smooth'});
  };
  requestAnimationFrame(step);
}
const capital=(text:string)=>text&&text[0].toUpperCase()+text.slice(1);
type RowProps={thread:Thread;actions:RowActions;phase?:'enter'|'exit';direction?:string;index?:number;active:boolean;cursor:boolean;selected:boolean;selecting:boolean;doneLeft:boolean;swipe:boolean;highlight?:Terms};
/**
 * One email. Unfocused it is a single line, "Sender: summary"; the focused one opens into a card with the whole
 * summary as a headline, the subject and keyed actions. A row on its way out keeps the look it had.
 */
const MailRow=memo(function MailRow({thread:t,actions:rows,phase,direction,index,active,cursor,selected,selecting,doneLeft,swipe,highlight:hl}:RowProps){
  const m=t.messages.at(-1)!;
  const sent=m.sent?m:undefined;
  const recipient=sent?.to[0]?.replace(/^\s*"?([^"<]+?)"?\s*<.*$/,'$1');
  const name=sent?(recipient?'To '+recipient+(sent.to.length>1?` +${sent.to.length-1}`:''):'No recipients'):m.fromName||m.from;
  const short=sent?name:shortSender(m.fromName,m.from);
  const exiting=phase==='exit';
  const focus=cursor,at=index;
  const attached=t.messages.some(message=>message.attachments.length>0);
  const today=ymd(new Date());const due=t.dueDate?.slice(0,10);const overdue=!!due&&due<today;
  const headline=capital(t.summary.trim())||t.subject||'(No subject)';
  const shift=useRef(false);
  const restorable=t.status==='trash'||t.status==='spam';
  const rowRef=useRef<HTMLDivElement>(null),bodyRef=useRef<HTMLDivElement>(null);const [swiping,setSwiping]=useState(false);
  const actionFor=(side:SwipeSide):'done'|'later'=>(side==='right')!==doneLeft?'done':'later';
  const gesture=useSwipe({enabled:swipe&&!restorable&&!selecting&&!exiting,host:rowRef,actionFor,onActive:setSwiping,
    canStart:target=>!target.closest('.card-actions, .row-leading'),onCommit:side=>rows.triage(t,actionFor(side))});
  // Exit keyframes collapse the card from its real height.
  // Remember the card's size and fill: exits collapse from it, and so does a card that loses focus, since by then
  // its content is already a single line and a CSS transition from `auto` would snap.
  const card=useRef<{height:number;fill:string}|null>(null);
  useLayoutEffect(()=>{
    const row=rowRef.current,body=bodyRef.current;if(!row||!body)return;
    if(focus){const style=getComputedStyle(row);card.current={height:body.offsetHeight+parseFloat(style.paddingTop)+parseFloat(style.paddingBottom),fill:getComputedStyle(body).backgroundColor};row.style.setProperty('--card-h',body.offsetHeight+'px');}
    else if(card.current){const from=card.current;card.current=null;if(!exiting&&!reducedMotion())row.animate([{height:from.height+'px',backgroundColor:from.fill},{height:row.offsetHeight+'px',backgroundColor:'transparent'}],{duration:220,easing:'cubic-bezier(.16,1,.3,1)'});}
  },[focus,exiting,t]);
  const subjectTerms=hl&&[...hl.any,...hl.subject];
  const chip=t.dueDate&&<Badge tone={overdue?'red':due===today?'blue':'neutral'} className="row-due" title={dueLabel(t.dueDate)}>{shortDue(t.dueDate)}</Badge>;
  const later=<Button key="later" size="sm" icon={Clock} shortcut={doneLeft?'→':'←'} onClick={()=>rows.triage(t,'later')} tooltip={{content:'Move to Todo',shortcut:'L'}}>Later</Button>;
  const done=<Button key="done" size="sm" icon={Check} className="card-done" shortcut={doneLeft?'←':'→'} onClick={()=>rows.triage(t,'done')} tooltip={{content:'Mark done',shortcut:'E'}}>Done</Button>;
  function click(e:React.MouseEvent){
    // The second click of a double-click may land on a neighbour once the cards resize; it opens the first row.
    if(e.detail>1&&lastClick&&lastClick.thread.id!==t.id&&performance.now()-lastClick.at<600){rows.open(lastClick.thread);return;}
    if(!focus&&rows.focus&&!e.shiftKey&&!e.metaKey&&!e.ctrlKey&&!selecting){lastClick={thread:t,at:performance.now()};holdStill(rowRef.current);}
    if(e.shiftKey)rows.select(t,'range');else if(e.metaKey||e.ctrlKey||selecting)rows.select(t,'toggle');
    else if(focus||!rows.focus)rows.open(t);else rows.focus(t);
  }
  return <div ref={rowRef} data-thread-id={t.id} className={cx('mail-row',focus&&'is-focus',t.unread&&'unread',active&&'active',selected&&'checked',selecting&&'selecting',phase&&'row-'+phase,exiting&&'row-exit-'+direction)} inert={exiting||undefined}
    style={at===undefined?undefined:{'--i':at} as React.CSSProperties} {...gesture}>
    {swiping&&<SwipeReveal actionFor={actionFor}/>}
    <div className="row-body" ref={bodyRef} onClick={e=>{if(focus&&e.target===e.currentTarget)click(e);}}>
      <div className="row-leading" onClickCapture={e=>{shift.current=e.shiftKey;}}>
        {focus?<Avatar name={recipient||m.fromName||m.from} seed={recipient||m.fromName||m.from} size={22}/>:t.unread&&<span className="unread-dot" aria-label="Unread"/>}
        <Checkbox className="row-checkbox" checked={selected} hideLabel label={'Select '+t.subject} onChange={()=>rows.select(t,shift.current?'range':'toggle')}/>
      </div>
      <button className="row-content" onClick={click} aria-label={focus?undefined:`${name}: ${headline}`}>
        <span className="row-line">
          <span className="sender"><Marked text={focus?name:short} terms={hl&&[...hl.any,...hl.from]}/></span>
          {focus&&t.messages.length>1&&<span className="thread-count">{t.messages.length}</span>}
          {!focus&&<span className="summary">{hl&&<span className="subject"><Marked text={t.subject} terms={subjectTerms}/></span>}<Marked text={headline} terms={hl?.any}/></span>}
          <span className="row-meta">
            {t.bookmarked&&<Bookmark size={13} className="row-flag" fill="currentColor"/>}
            {chip}
            {attached&&<Paperclip size={13} className="row-clip"/>}
            <span className="row-time">{dateLabel(t.date)}</span>
          </span>
        </span>
        {focus&&<span className="card-headline"><Marked text={headline} terms={hl?.any}/></span>}
        {focus&&<span className="card-detail"><span className="subject"><Marked text={t.subject||'(No subject)'} terms={subjectTerms}/></span>{t.todo&&<span className="card-todo"><CircleCheck size={13}/>{t.todo}</span>}</span>}
      </button>
      {focus&&<div className="card-actions">
        {restorable?<Button size="sm" icon={RotateCcw} onClick={()=>rows.restore(t)}>Restore</Button>
        :<Button size="sm" icon={Bookmark} iconFill={t.bookmarked?'currentColor':'none'} className={cx('card-bookmark',t.bookmarked&&'is-on')} shortcut="B" aria-label={t.bookmarked?'Remove bookmark':'Bookmark'} aria-pressed={t.bookmarked} onClick={()=>rows.bookmark(t)} tooltip={{content:t.bookmarked?'Remove bookmark':'Bookmark',shortcut:'B'}}/>}
        {!restorable&&(doneLeft?done:later)}
        <Button size="sm" variant="primary" icon={ArrowUpRight} shortcut="Space" className="card-open" onClick={()=>rows.open(t)}>Open</Button>
        {!restorable&&(doneLeft?later:done)}
        <IconButton className="card-more" size="sm" label="More actions" shortcut="." icon={MoreHorizontal} onClick={e=>rows.more(t,e.currentTarget)}/>
      </div>}
    </div>
  </div>;
});

/** What a sideways drag will do, shown under the row on the side it uncovers. */
function SwipeReveal({actionFor}:{actionFor:(side:SwipeSide)=>'done'|'later'}){
  return <div className="swipe-reveal" aria-hidden="true">{(['right','left'] as const).map(side=>{const action=actionFor(side);return <span key={side} className="swipe-action" data-for={side}>
    {action==='done'?<Check size={17}/>:<Clock size={17}/>}<span>{action==='done'?'Done':'Todo'}</span></span>;})}</div>;
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
