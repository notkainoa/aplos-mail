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
type Ghost={id:number;mail:Mail;action:Action};
const verb:Record<Action,string>={later:'Set aside for Later',done:'Marked Done',reply:'Opened a reply'};

function Card({mail,onAct,ghost}:{mail:Mail;onAct?:(a:Action)=>void;ghost?:Action}) {
  return (
    <div className={`mail${ghost?` leaving leaving-${ghost}`:' entering'}`} aria-hidden={ghost?true:undefined}>
      <div className="mail-top">
        <span className="avatar" style={{background:`hsl(${mail.hue} 42% 38%)`}}>{mail.sender[0]}</span>
        <span className="sender">{mail.sender}</span>
        <span className="grow" />
        {mail.due&&<span className={`chip${mail.overdue?' chip-alert':''}`}>{mail.due}</span>}
        <span className="when">{mail.when}</span>
      </div>
      <p className="summary">{mail.summary}</p>
      <div className="actions">
        <button type="button" tabIndex={-1} className="act act-primary" onClick={()=>onAct?.('reply')}>Reply <kbd>Space</kbd></button>
        <span className="grow" />
        <button type="button" tabIndex={-1} className="act" onClick={()=>onAct?.('later')}>Later <kbd>←</kbd></button>
        <button type="button" tabIndex={-1} className="act" onClick={()=>onAct?.('done')}>Done <kbd>→</kbd></button>
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

  const act=useCallback((action:Action)=>{
    if(index>=mails.length)return;
    const id=++ghostId.current;
    setGhosts(g=>[...g,{id,mail:mails[index],action}]);
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
  const hint=focused?'Space replies, ← sets it aside, → marks it done, Z undoes.':'Click the card, then press Space, ← or →.';

  return (
    <div className="triage" data-ui tabIndex={0} role="group" aria-label="Try Home. Click, then use Space, the left and right arrow keys and Z." aria-keyshortcuts="Space ArrowLeft ArrowRight Z"
      onKeyDown={onKeyDown} onFocus={()=>setFocused(true)} onBlur={()=>setFocused(false)}>
      <div className="triage-head">
        <span>Home</span>
        <span>{left>0?`${left} ${left===1?'email':'emails'}`:'Done'}</span>
      </div>
      <div className="triage-stage">
        {ghosts.map(g=><Card key={`g${g.id}`} mail={g.mail} ghost={g.action} />)}
        {mail
          ? <Card key={index} mail={mail} onAct={act} />
          : <div className="triage-empty"><p>Inbox finished.</p><button type="button" className="act" tabIndex={-1} onClick={()=>{setIndex(0);setHistory([]);setStatus('');}}>Start over</button></div>}
      </div>
      <ul className="triage-next" aria-hidden="true">
        {mails.slice(index+1,index+3).map(m=><li key={m.sender}><b>{m.sender}</b><span>{m.summary}</span></li>)}
      </ul>
      <p className="triage-hint" aria-live="polite">{status&&focused?status:hint}</p>
    </div>
  );
}
