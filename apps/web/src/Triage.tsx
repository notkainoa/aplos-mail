import {useCallback,useRef,useState} from 'react';

// Original sample mail from the app's demo data. Nothing here is real.
type Mail={sender:string;summary:string;due?:string;overdue?:boolean;when:string;hue:number};
const mails:Mail[]=[
  {sender:'Jordan Park',summary:'Two layout directions ready, wants your preference by tomorrow',due:'by tomorrow',when:'10:00 AM',hue:172},
  {sender:'Maple Library',summary:'Two holds waiting at the front desk until the end of the week',due:'by Sun',when:'Yesterday',hue:210},
  {sender:'Rowan Pottery',summary:'A seat opened in the Tuesday evening class, reply to reserve it',when:'Tuesday',hue:28},
  {sender:'Drew',summary:'October illustrations finished, approve the invoice to close out',due:'overdue',overdue:true,when:'Yesterday',hue:262},
  {sender:'Leah',summary:'Pick a quiet lunch spot for six with vegetarian choices',when:'Tuesday',hue:140},
];
type Action='later'|'done'|'reply';
type Ghost={id:number;mail:Mail;action:Action;x:number};
const verb:Record<Action,string>={later:'Set aside for Later',done:'Marked Done',reply:'Opened a reply'};

// The card in focus can be dragged sideways, as in the app: past the threshold, or flicked, it goes to Later (left) or Done (right).
function Card({mail,onAct,ghost,from=0,onDrag}:{mail:Mail;onAct?:(a:Action,x?:number)=>void;ghost?:Action;from?:number;onDrag?:(x:number)=>void}) {
  const ref=useRef<HTMLDivElement>(null);
  const drag=useRef<{id:number;x0:number;x:number;lastX:number;lastT:number;v:number;moving:boolean}|null>(null);
  const place=(x:number,animate:boolean)=>{
    const el=ref.current!;
    el.style.transition=animate?'transform 320ms var(--ease-out)':'none';
    el.style.transform=x?`translateX(${x}px) rotate(${x/30}deg)`:'';
    onDrag?.(x);
  };
  const down=(event:React.PointerEvent)=>{
    if(ghost||event.button!==0||(event.target as HTMLElement).closest('button'))return;
    drag.current={id:event.pointerId,x0:event.clientX,x:0,lastX:event.clientX,lastT:event.timeStamp,v:0,moving:false};
  };
  const move=(event:React.PointerEvent)=>{
    const d=drag.current;if(!d||d.id!==event.pointerId)return;
    const x=event.clientX-d.x0;
    if(!d.moving){if(Math.abs(x)<6)return;d.moving=true;ref.current!.setPointerCapture(event.pointerId);}
    const dt=event.timeStamp-d.lastT;if(dt>0)d.v=(event.clientX-d.lastX)/dt;
    d.lastX=event.clientX;d.lastT=event.timeStamp;d.x=x;place(x,false);
  };
  const up=()=>{
    const d=drag.current;drag.current=null;if(!d?.moving)return;
    if(Math.abs(d.x)>110||(Math.abs(d.v)>0.5&&Math.abs(d.x)>30&&Math.sign(d.v)===Math.sign(d.x))){onDrag?.(0);onAct?.(d.x<0?'later':'done',d.x);}
    else place(0,true);
  };
  return (
    <div ref={ref} className={`mail${ghost?` leaving leaving-${ghost}`:' entering'}`} aria-hidden={ghost?true:undefined}
      style={ghost?{'--x':`${from}px`,'--r':`${from/30}deg`} as React.CSSProperties:undefined}
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
      <div className="mail-top">
        <span className="avatar" style={{background:`hsl(${mail.hue} 42% 38%)`}}>{mail.sender[0]}</span>
        <span className="sender">{mail.sender}</span>
        <span className="grow" />
        {mail.due&&<span className={`chip${mail.overdue?' chip-alert':''}`}>{mail.due}</span>}
        <span className="when">{mail.when}</span>
      </div>
      <p className="summary">{mail.summary}</p>
      <div className="actions">
        <button type="button" tabIndex={-1} className={`act act-primary${ghost==='reply'?' is-pressed':''}`} onClick={()=>onAct?.('reply')}>Reply <kbd>Space</kbd></button>
        <span className="grow" />
        <button type="button" tabIndex={-1} className={`act${ghost==='later'?' is-pressed':''}`} onClick={()=>onAct?.('later')}>Later <kbd>←</kbd></button>
        <button type="button" tabIndex={-1} className={`act${ghost==='done'?' is-pressed':''}`} onClick={()=>onAct?.('done')}>Done <kbd>→</kbd></button>
      </div>
    </div>
  );
}

// A small working copy of Home: one email in focus, acted on with the same keys as the app.
// Each action sends a ghost of the card off while the next one comes in, so quick presses never wait on an animation.
export function Triage() {
  const [index,setIndex]=useState(0);
  const [ghosts,setGhosts]=useState<Ghost[]>([]);
  const [history,setHistory]=useState<number[]>([]);
  const [status,setStatus]=useState('');
  const [focused,setFocused]=useState(false);
  const ghostId=useRef(0);
  const mail=mails[index];

  const hints=useRef<HTMLDivElement>(null);
  const showHints=useCallback((x:number)=>{
    const [done,later]=hints.current?.children??[];
    if(done)(done as HTMLElement).style.opacity=String(Math.min(1,Math.max(0,x)/110));
    if(later)(later as HTMLElement).style.opacity=String(Math.min(1,Math.max(0,-x)/110));
  },[]);
  const act=useCallback((action:Action,x=0)=>{
    if(index>=mails.length)return;
    const id=++ghostId.current;
    setGhosts(g=>[...g,{id,mail:mails[index],action,x}]);
    window.setTimeout(()=>setGhosts(g=>g.filter(x=>x.id!==id)),340);
    setHistory(h=>[...h,index]);
    setIndex(index+1);
    setStatus(`${verb[action]}: ${mails[index].sender}`);
  },[index]);

  const undo=useCallback(()=>{
    if(!history.length)return;
    const previous=history[history.length-1];
    setHistory(history.slice(0,-1));
    setIndex(previous);
    setStatus(`Undone: ${mails[previous].sender}`);
  },[history]);

  const onKeyDown=(event:React.KeyboardEvent)=>{
    if(event.metaKey||event.ctrlKey||event.altKey)return;
    const key=event.key;
    if(key===' ')act('reply');
    else if(key==='ArrowLeft')act('later');
    else if(key==='ArrowRight')act('done');
    else if(key==='z'||key==='Z')undo();
    else return;
    event.preventDefault();
  };

  const left=mails.length-index;
  const touch=typeof window!=='undefined'&&window.matchMedia('(pointer: coarse)').matches;
  const hint=focused?'Space replies, ← sets it aside, → marks it done, Z undoes.':touch?'Swipe the card: left for Later, right for Done.':'Click the card, then press Space, ← or →, or drag it sideways.';

  return (
    <div className="triage" data-ui tabIndex={0} role="group" aria-label="Try Home. Click, then use Space, the left and right arrow keys and Z." aria-keyshortcuts="Space ArrowLeft ArrowRight Z"
      onKeyDown={onKeyDown} onFocus={()=>setFocused(true)} onBlur={()=>setFocused(false)}>
      <div className="triage-head">
        <span>Home</span>
        <span>{left>0?`${left} ${left===1?'email':'emails'}`:'Done'}</span>
      </div>
      <div className="triage-stage">
        <div className="swipe-hints" ref={hints} aria-hidden="true"><span>Done</span><span>Later</span></div>
        {ghosts.map(g=><Card key={`g${g.id}`} mail={g.mail} ghost={g.action} from={g.x} />)}
        {mail
          ? <Card key={index} mail={mail} onAct={act} onDrag={showHints} />
          : <div className="triage-empty"><p>Inbox finished.</p><button type="button" className="act" tabIndex={-1} onClick={()=>{setIndex(0);setHistory([]);setStatus('');}}>Start over</button></div>}
      </div>
      <ul className="triage-next" aria-hidden="true">
        {mails.slice(index+1,index+3).map(m=><li key={m.sender}><b>{m.sender}</b><span>{m.summary}</span></li>)}
      </ul>
      <p className="triage-hint" aria-live="polite">{status&&focused?status:hint}</p>
    </div>
  );
}
