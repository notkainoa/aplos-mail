import {useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {ArrowUpRight,Check,ChevronsUpDown,Copy,KeyRound,Search} from '../icons';
import {Badge,Button,Group,GroupRow,Popover,Spinner,cx} from '../ui';
import {askProvider,askProviders,defaultAskModel,parseAskModel,type AskModelInfo,type AskProviderId} from '../../shared/ask';
import {invoke,openUrl,uid} from '../bridge';

type Catalog={id:AskProviderId;label:string;env:string;description:string;available:boolean;models:AskModelInfo[]}[];
const keyPages:Record<AskProviderId,string>={groq:'https://console.groq.com/keys',openrouter:'https://openrouter.ai/settings/keys','opencode-go':'https://opencode.ai/console'};
const shortDescriptions:Record<AskProviderId,string>={groq:'Very fast open models. Also runs the rest of Aplos’s AI.',openrouter:'Claude, Gemini, Kimi and hundreds more on one key.','opencode-go':'Use your OpenCode Go plan’s models.'};

/** Settings → AI: where Ask runs, which model, a real connection check, and what else uses Groq. */
export function AiSettings({value,groqReady,onChange}:{value:string;groqReady:boolean;onChange:(value:string)=>void}){
  const [catalog,setCatalog]=useState<Catalog>();
  useEffect(()=>{let live=true;void invoke<Catalog>('ai.models').then(list=>{if(live)setCatalog(list);}).catch(()=>{});return()=>{live=false;};},[]);
  const providers:Catalog=catalog??askProviders.map(p=>({...p,models:[...p.models],available:p.id==='groq'?groqReady:false}));
  const ref=parseAskModel(value)??parseAskModel(defaultAskModel)!;
  const provider=providers.find(p=>p.id===ref.provider)??providers[0];
  // A model chosen earlier that the list no longer shows stays visible rather than silently switching.
  const models=provider.models.some(m=>m.id===ref.model)?provider.models:[{id:ref.model,label:ref.model},...provider.models];
  const model=models.find(m=>m.id===ref.model)!;
  function pickProvider(id:AskProviderId){
    if(id===provider.id)return;
    const next=providers.find(p=>p.id===id);const first=next?.models[0]??askProvider(id).models[0];
    if(first)onChange(`${id}:${first.id}`);
  }
  return <div className="ai-settings">
    <Group title="Ask">
      <div className="ai-providers-wrap">
        <ProviderCards providers={providers} value={provider.id} loading={!catalog} onChange={pickProvider}/>
        {catalog&&!provider.available&&<KeySetup key={provider.id} provider={provider}/>}
      </div>
      <GroupRow label="Model" description={model.description??(models.length>8?`${models.length} models on ${provider.label} can use Ask’s tools.`:undefined)}>
        <ModelPicker provider={provider} models={models} value={ref.model} onChange={id=>onChange(`${provider.id}:${id}`)}/>
      </GroupRow>
      <ConnectionCheck key={value} model={value} ready={provider.available}/>
    </Group>
    <Group title="Also on Groq">
      <GroupRow label="Summaries, drafts and plans" description="Sorts and summarizes new mail, polishes drafts and finds plans in email."><Status ready={groqReady}/></GroupRow>
      <GroupRow label="Voice" description="Hold A to talk. Groq Whisper turns speech into text."><Status ready={groqReady}/></GroupRow>
    </Group>
    <p className="group-note ai-note"><KeyRound size={13}/>Keys stay in the backend environment and never reach this window. Nothing is sent from your mailbox without your click.</p>
  </div>;
}

const Status=({ready}:{ready:boolean})=>ready?<Badge tone="green">Ready</Badge>:<Badge tone="amber">Needs GROQ_API_KEY</Badge>;

/** Three choices as cards. The selection ring glides to the chosen card. */
function ProviderCards({providers,value,loading,onChange}:{providers:Catalog;value:AskProviderId;loading:boolean;onChange:(id:AskProviderId)=>void}){
  const list=useRef<HTMLDivElement>(null);
  const [ring,setRing]=useState<{x:number;y:number;w:number;h:number}|null>(null);const [animate,setAnimate]=useState(false);
  useLayoutEffect(()=>{
    const root=list.current;if(!root)return;
    const measure=()=>{const el=root.querySelector<HTMLElement>('[aria-checked="true"]');setRing(el?{x:el.offsetLeft,y:el.offsetTop,w:el.offsetWidth,h:el.offsetHeight}:null);};
    measure();const observer=new ResizeObserver(measure);observer.observe(root);return()=>observer.disconnect();
  },[value]);
  // No glide on first paint, only between choices.
  useLayoutEffect(()=>{if(ring&&!animate){const frame=requestAnimationFrame(()=>setAnimate(true));return()=>cancelAnimationFrame(frame);}},[ring]);
  function key(event:React.KeyboardEvent){
    const at=providers.findIndex(p=>p.id===value);const step=event.key==='ArrowRight'||event.key==='ArrowDown'?1:event.key==='ArrowLeft'||event.key==='ArrowUp'?-1:0;
    if(!step)return;event.preventDefault();const next=providers[(at+step+providers.length)%providers.length];onChange(next.id);
    requestAnimationFrame(()=>list.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus());
  }
  return <div ref={list} className="ai-providers" role="radiogroup" aria-label="Ask provider" onKeyDown={key}>
    {ring&&<span className={cx('ai-provider-ring',animate&&'is-animated')} aria-hidden="true" style={{transform:`translate(${ring.x}px,${ring.y}px)`,width:ring.w,height:ring.h}}/>}
    {providers.map(p=>{const selected=p.id===value;return <button key={p.id} type="button" role="radio" aria-checked={selected} tabIndex={selected?0:-1} className={cx('ai-provider',selected&&'is-selected')} onClick={()=>onChange(p.id)}>
      <span className="ai-provider-head"><strong>{p.label}</strong>{selected&&<span className="ai-provider-check"><Check size={11}/></span>}</span>
      <span className="ai-provider-text">{shortDescriptions[p.id]}</span>
      <span className={cx('ai-provider-status',loading?'is-loading':p.available?'is-ready':'is-missing')}><i/>{loading?'Checking…':p.available?'Ready':'Needs a key'}</span>
    </button>;})}
  </div>;
}

/** What to do when the chosen provider has no key: the variable to set and where to get a key. */
function KeySetup({provider}:{provider:Catalog[number]}){
  const [copied,setCopied]=useState(false);
  async function copy(){try{await navigator.clipboard.writeText(`${provider.env}=`);setCopied(true);setTimeout(()=>setCopied(false),1600);}catch{/* Clipboard access can be refused; the name is still on screen. */}}
  return <div className="ai-setup" role="status">
    <p><strong>Add your {provider.label} key to finish.</strong> Ask won’t answer with {provider.label} until it is set. Put it in the backend <code>.env</code>, then restart Aplos.</p>
    <div className="ai-setup-actions">
      <button type="button" className={cx('ai-env',copied&&'is-copied')} onClick={()=>void copy()} aria-label={`Copy ${provider.env}`}><code>{provider.env}=</code><span>{copied?<><Check size={12}/>Copied</>:<><Copy size={12}/>Copy</>}</span></button>
      <Button variant="text" size="sm" iconRight={ArrowUpRight} onClick={()=>void openUrl(keyPages[provider.id])}>Get a key</Button>
    </div>
  </div>;
}

/** A searchable list of models. Arrows move, Enter picks, Esc closes; the selected model is checked. */
function ModelPicker({provider,models,value,onChange}:{provider:Catalog[number];models:AskModelInfo[];value:string;onChange:(id:string)=>void}){
  const trigger=useRef<HTMLButtonElement>(null);const listRef=useRef<HTMLDivElement>(null);
  const [open,setOpen]=useState(false);const [query,setQuery]=useState('');const [active,setActive]=useState(0);const [listId]=useState(()=>'models-'+uid());
  const curated=useMemo(()=>new Set(askProvider(provider.id).models.map(m=>m.id)),[provider.id]);
  const words=query.toLowerCase().split(/\s+/).filter(Boolean);
  const shown=useMemo(()=>models.filter(m=>words.every(w=>`${m.label} ${m.id} ${m.description??''}`.toLowerCase().includes(w))),[models,query]);
  const groups=[{title:'Recommended',items:shown.filter(m=>curated.has(m.id))},{title:curated.size&&shown.some(m=>curated.has(m.id))?'All models':'',items:shown.filter(m=>!curated.has(m.id))}].filter(g=>g.items.length);
  const flat=groups.flatMap(g=>g.items);const current=models.find(m=>m.id===value);
  const searchable=models.length>8;
  // Opening starts from the full list with the current model highlighted.
  function show(next:boolean){
    if(next){const order=[...models.filter(m=>curated.has(m.id)),...models.filter(m=>!curated.has(m.id))];setQuery('');setActive(Math.max(0,order.findIndex(m=>m.id===value)));}
    setOpen(next);
  }
  useEffect(()=>{if(open)listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({block:'nearest'});},[active,open]);
  // Focus moves into the picker so typing searches (or jumps) instead of reaching the app's shortcuts.
  const search=useRef<HTMLInputElement>(null);
  useEffect(()=>{if(!open)return;const frame=requestAnimationFrame(()=>(search.current??listRef.current)?.focus({preventScroll:true}));return()=>cancelAnimationFrame(frame);},[open]);
  function choose(id:string){onChange(id);setOpen(false);trigger.current?.focus({preventScroll:true});}
  function keys(event:React.KeyboardEvent){
    if(!event.metaKey&&!event.ctrlKey&&event.key!=='Escape')event.stopPropagation();
    // A short list without search jumps to the first model starting with the typed letter.
    if(!searchable&&event.key.length===1&&/\S/.test(event.key)){const at=flat.findIndex(m=>m.label.toLowerCase().startsWith(event.key.toLowerCase()));if(at>=0)setActive(at);return;}
    if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();if(!flat.length)return;const step=event.key==='ArrowDown'?1:-1;setActive(i=>(i+step+flat.length)%flat.length);}
    else if(event.key==='Enter'){event.preventDefault();const item=flat[active];if(item)choose(item.id);}
    else if(event.key==='Home'&&!searchable){event.preventDefault();setActive(0);}else if(event.key==='End'&&!searchable){event.preventDefault();setActive(flat.length-1);}
  }
  let index=-1;
  return <>
    <button ref={trigger} type="button" className={cx('ai-model-trigger',open&&'is-open')} aria-haspopup="listbox" aria-expanded={open} onClick={()=>show(!open)} onKeyDown={event=>{if(event.key==='ArrowDown'&&!open){event.preventDefault();show(true);}}}>
      <span><strong>{current?.label??value}</strong>{current&&current.label!==current.id&&<small>{current.id}</small>}</span><ChevronsUpDown size={13}/>
    </button>
    <Popover open={open} anchor={trigger.current} onClose={()=>setOpen(false)} placement="bottom-end" className="ui-surface ai-model-picker" label={`${provider.label} models`} onKeyDown={keys}>
      {searchable&&<label className="ai-model-search"><Search size={14}/><input ref={search} aria-controls={listId} aria-activedescendant={flat[active]?`${listId}-${active}`:undefined} placeholder={`Search ${models.length} models`} value={query} onChange={e=>{setQuery(e.target.value);setActive(0);}}/></label>}
      <div ref={listRef} id={listId} className="ai-model-list" role="listbox" tabIndex={searchable?-1:0} aria-label="Models">
        {groups.map(group=><div key={group.title||'all'} role="group" aria-label={group.title||undefined}>
          {group.title&&groups.length>1&&<p className="ai-model-group">{group.title}{group.title==='All models'&&<span>{group.items.length}</span>}</p>}
          {group.items.map(m=>{index++;const i=index;const selected=m.id===value;
            return <div key={m.id} id={`${listId}-${i}`} role="option" aria-selected={selected} data-active={i===active} className={cx('ui-surface-item ai-model',i===active&&'is-active',selected&&'is-selected')} onPointerMove={()=>{if(active!==i)setActive(i);}} onMouseDown={e=>e.preventDefault()} onClick={()=>choose(m.id)}>
              <span className="ai-model-check">{selected&&<Check size={13}/>}</span>
              <span className="ai-model-text"><strong>{m.label}</strong><small>{m.description??m.id}</small></span>
            </div>;})}
        </div>)}
        {!flat.length&&<p className="ai-model-empty">No models match “{query}”.</p>}
      </div>
    </Popover>
  </>;
}

type Check={state:'idle'}|{state:'running'}|{state:'ok';ms:number;tools:boolean}|{state:'error';message:string};
/** A real request to the chosen model, so a key or model problem shows here rather than mid-question. */
function ConnectionCheck({model,ready}:{model:string;ready:boolean}){
  const [check,setCheck]=useState<Check>({state:'idle'});const request=useRef<string|undefined>(undefined);
  useEffect(()=>()=>{if(request.current)void invoke('ai.cancel',{requestId:request.current}).catch(()=>{});},[]);
  async function run(){
    const requestId=uid();request.current=requestId;setCheck({state:'running'});
    try{const result=await invoke<{ms:number;tools:boolean}>('ai.test',{model,requestId});if(request.current===requestId)setCheck({state:'ok',...result});}
    catch(e){if(request.current===requestId)setCheck({state:'error',message:(e as Error).message});}
    finally{if(request.current===requestId)request.current=undefined;}
  }
  const seconds=(ms:number)=>ms<1000?`${Math.round(ms/10)*10} ms`:`${(ms/1000).toFixed(1)} s`;
  return <GroupRow label="Check connection" description="Sends one tiny request and asks the model to use a tool, the way Ask does. No mail is included.">
    <span className={cx('ai-check',`is-${check.state==='ok'&&!check.tools?'warn':check.state}`)} role="status" aria-live="polite">
      {check.state==='running'&&<><Spinner size={13}/>Checking…</>}
      {check.state==='ok'&&(check.tools?<><span className="ai-check-mark"><Check size={11}/></span>Works · {seconds(check.ms)}</>:<>Replied in {seconds(check.ms)}, but didn’t use the tool. Ask may not work well with this model.</>)}
      {check.state==='error'&&check.message}
    </span>
    <Button variant="secondary" size="sm" disabled={!ready||check.state==='running'} onClick={()=>void run()}>{check.state==='ok'||check.state==='error'?'Check again':'Check'}</Button>
  </GroupRow>;
}
