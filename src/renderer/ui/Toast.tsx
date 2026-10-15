import {useEffect,useRef,useState,useSyncExternalStore} from 'react';
import {X} from '../icons';
import {Keys} from './Kbd';
import {cx,duration,reducedMotion} from './motion';

export type ToastAction={label:string;shortcut?:string;run:()=>void};
export type ToastSpec={text:string;action?:ToastAction;tone?:'neutral'|'error';duration?:number};
type Entry=ToastSpec&{id:number;leaving?:boolean};

let toasts:Entry[]=[];let seq=0;
const listeners=new Set<()=>void>();
const emit=()=>{for(const listener of listeners)listener();};
const visible=3;

function remove(id:number){
  const entry=toasts.find(t=>t.id===id);if(!entry||entry.leaving)return;
  if(reducedMotion()){toasts=toasts.filter(t=>t.id!==id);emit();return;}
  toasts=toasts.map(t=>t.id===id?{...t,leaving:true}:t);emit();
  setTimeout(()=>{toasts=toasts.filter(t=>t.id!==id);emit();},duration.base);
}

export const toast={
  show(spec:ToastSpec|string){
    const value=typeof spec==='string'?{text:spec}:spec;
    // Only the newest action stays live: an older "Undo" would no longer undo what it says.
    const older=value.action?toasts.map(t=>t.action?{...t,action:undefined}:t):toasts;
    const entry={...value,id:++seq};
    toasts=[...older.filter(t=>!t.leaving),entry].slice(-visible-1);emit();
    return entry.id;
  },
  dismiss:remove,
  /** Retire toasts whose action has been performed some other way (e.g. Z for Undo). */
  dismissActions(){for(const t of toasts)if(t.action)remove(t.id);},
};

export function Toaster(){
  const list=useSyncExternalStore(listener=>{listeners.add(listener);return()=>listeners.delete(listener);},()=>toasts,()=>toasts);
  const [hover,setHover]=useState(false);
  const live=list.filter(t=>!t.leaving);
  // Pause on real movement only: a toast that appears under a resting cursor gets synthetic enter events and would never expire.
  return <div className={cx('ui-toaster',hover&&'is-expanded')} aria-live="polite" onPointerMove={e=>{if(!hover&&(e.movementX||e.movementY))setHover(true);}} onPointerLeave={()=>setHover(false)}>
    {list.map(entry=>{const depth=entry.leaving?0:live.length-1-live.indexOf(entry);return <ToastCard key={entry.id} entry={entry} depth={depth} paused={hover}/>;})}
  </div>;
}

function ToastCard({entry,depth,paused}:{entry:Entry;depth:number;paused:boolean}){
  const remaining=useRef(entry.duration??(entry.action?7000:4200));const started=useRef(Date.now());
  useEffect(()=>{
    if(paused||entry.leaving)return;
    started.current=Date.now();
    const timer=setTimeout(()=>remove(entry.id),remaining.current);
    return()=>{clearTimeout(timer);remaining.current-=Date.now()-started.current;};
  },[paused,entry.leaving]);
  return <div role={entry.tone==='error'?'alert':'status'} className={cx('ui-toast',entry.tone==='error'&&'is-error',entry.leaving&&'is-leaving',depth>=visible&&'is-hidden')} data-front={depth===0||undefined} style={{'--depth':depth} as React.CSSProperties}>
    <span className="ui-toast-text">{entry.text}</span>
    {entry.action&&<button className="ui-toast-action" onClick={()=>{entry.action!.run();remove(entry.id);}}>{entry.action.label}{entry.action.shortcut&&<Keys combo={entry.action.shortcut} size="sm"/>}</button>}
    <button className="ui-toast-dismiss" aria-label="Dismiss notification" onClick={()=>remove(entry.id)}><X size={11}/></button>
  </div>;
}
