import {useCallback,useEffect,useRef,useState} from 'react';
import {ArrowRight,Check,KeyRound,Mail,Mic,Plus,RefreshCw} from '../icons';
import {AppIcon} from './AppIcon';
import type {AppState,Capabilities,SetupProgress,Settings} from '../../shared/types';
import {aiFeatures,askProvider,voiceProviders,type AiModelSetting,type AskProviderId} from '../../shared/ask';
import {appVersion} from '../../shared/version';
import {bridge,invoke} from '../bridge';
import {Button,Kbd,Keys,Select,Spinner,cx} from '../ui';
import {AddAccountForm} from './AddAccount';
import {ApiKeyField,useKeyStore} from './ApiKey';

/** Onboarding has its own window on the desktop; the browser preview shows it as a page of its own (`?onboarding`). */
const desktop=!!window.aplos;
/** Opens onboarding again (Settings → Help & about). Nothing is reset: accounts and keys show as already set up. */
export function showWelcome(){if(desktop)void invoke('onboarding.open');else location.assign('?onboarding=1');}

type Step='start'|'account'|'ai'|'mic'|'sync';
const dots:Step[]=['start','ai','mic','sync'];
/** Providers that take a pasted key. Local servers need an address too, so they stay in Settings → AI. */
const keyed:AskProviderId[]=['groq','openai','anthropic','gemini','openrouter','opencode-go'];
type Microphone='unknown'|'not-determined'|'granted'|'denied'|'restricted'|'asking';

/** The demo is only ever loaded on request: from onboarding, the empty Home or Settings. Real accounts are kept. */
export async function loadDemo(){await invoke('demo.reset');}

/** The parts of the app state onboarding needs, refreshed when the engine reports a change. */
function useSetupState(){
  const [state,setState]=useState<AppState>();const [capabilities,setCapabilities]=useState<Capabilities>({groq:false,google:false,microsoft:false,desktop,version:appVersion});
  const refresh=useCallback(()=>invoke<AppState>('state.get',{threadLimit:1}).then(setState).catch(()=>{}),[]);
  useEffect(()=>{
    void refresh();void invoke<Capabilities>('capabilities.get').then(setCapabilities).catch(()=>{});
    let timer:ReturnType<typeof setTimeout>|undefined;
    const off=bridge.subscribe(event=>{if(event.type!=='changes'&&event.type!=='state')return;clearTimeout(timer);timer=setTimeout(()=>void refresh(),150);});
    return ()=>{off();clearTimeout(timer);};
  },[refresh]);
  // Follows the app's theme setting, like the main window.
  const theme=state?.settings.theme;
  useEffect(()=>{if(!theme)return;const media=matchMedia('(prefers-color-scheme: dark)');const apply=()=>document.documentElement.dataset.theme=theme==='system'?(media.matches?'dark':'light'):theme;apply();media.addEventListener('change',apply);return ()=>media.removeEventListener('change',apply);},[theme]);
  return {state,capabilities,refresh};
}

/**
 * The first run, in a window of its own: welcome, accounts (the usual add-account form, full window), an AI key and the
 * microphone, then a loading screen while every account syncs and AI reads the newest mail. The mail window opens only
 * after that. Escape skips a step; Enter continues. Demo mail is a quiet corner link that loads the demo when clicked.
 */
export function Onboarding(){
  const {state,capabilities,refresh}=useSetupState();
  const [step,setStep]=useState<Step>('start');const [demoBusy,setDemoBusy]=useState(false);const [error,setError]=useState('');
  const body=useRef<HTMLElement>(null);
  const real=state?.accounts.filter(a=>a.provider!=='demo')??[];const canDemo=!!state&&!state.accounts.some(a=>a.provider==='demo');
  const finishing=useRef(false);
  const finish=useCallback(async()=>{
    if(finishing.current)return;finishing.current=true;
    try{
      await invoke('settings.update',{patch:{onboardingDone:true}});
      if(desktop)await invoke('onboarding.finish');else location.replace(location.pathname);
    }catch(e){finishing.current=false;setError((e as Error).message);}
  },[]);
  // With nothing to sync (no accounts, or only the demo) there is no loading screen.
  const afterMic=()=>{if(real.length)setStep('sync');else void finish();};
  const next=()=>{setError('');if(step==='start')setStep('ai');else if(step==='ai')setStep('mic');else if(step==='mic')afterMic();};
  // Escape skips: setup from the first step (accounts already added still sync), the add-account page back to the start.
  const skip=()=>{
    setError('');
    if(step==='account')setStep('start');
    else if(step==='start'){if(real.length)setStep('sync');else void finish();}
    else if(step!=='sync')next();
  };
  const skipRef=useRef(skip);skipRef.current=skip;
  useEffect(()=>{const key=(e:KeyboardEvent)=>{if(e.key==='Escape'&&!e.defaultPrevented&&!document.querySelector('.ui-dialog, .ui-menu')){e.preventDefault();skipRef.current();}};addEventListener('keydown',key);return ()=>removeEventListener('keydown',key);},[]);
  // Each step puts focus on its main action, so Enter moves on and Tab starts from there.
  useEffect(()=>{const frame=requestAnimationFrame(()=>{const el=body.current;(el?.querySelector<HTMLElement>('[data-autofocus]:not([disabled])')??el)?.focus({preventScroll:true});});return()=>cancelAnimationFrame(frame);},[step,!!state,real.length]);
  async function tryDemo(){
    setDemoBusy(true);setError('');
    try{await loadDemo();await refresh();setStep('ai');}catch(e){setError((e as Error).message);}finally{setDemoBusy(false);}
  }
  const index=dots.indexOf(step==='account'?'start':step);
  const hint=step==='start'?'Skip setup':step==='account'?'Back':step==='sync'?undefined:'Skip this step';
  if(!state)return <div className="onboarding-window"><div className="onboarding-titlebar"/></div>;
  return <div className={cx('onboarding-window','is-'+step)}>
    <div className="onboarding-titlebar"/>
    {step==='start'&&canDemo&&<Button variant="text" size="sm" className="onboarding-demo" loading={demoBusy} tooltip={{content:'Look around with sample mail',detail:'Two original demo accounts. Nothing is sent to real people.'}} onClick={()=>void tryDemo()}>Try demo mail</Button>}
    <main ref={body} className="onboarding-page" key={step} tabIndex={-1}>
      {error&&<p className="onboarding-error" role="alert">{error}</p>}
      {step==='start'&&(real.length?<>
        <AppIcon size={64}/>
        <h1>Your accounts</h1>
        <p>Add every address you use. They all land in one calm inbox.</p>
        <ul className="onboarding-accounts">{real.map(a=><li key={a.id}><span className="account-dot" style={{background:a.color}}/>{a.email}<Check size={13}/></li>)}</ul>
        <div className="onboarding-actions">
          <Button variant="secondary" icon={Plus} onClick={()=>setStep('account')}>Add another</Button>
          <Button variant="primary" iconRight={ArrowRight} data-autofocus onClick={next}>Continue</Button>
        </div>
      </>:<>
        <AppIcon size={88}/>
        <h1>Welcome to Aplos.</h1>
        <p>Your mail and calendar, one calm email at a time.</p>
        <div className="onboarding-actions is-stacked">
          <Button variant="primary" size="lg" icon={Mail} data-autofocus disabled={demoBusy} onClick={()=>setStep('account')}>Add an account</Button>
        </div>
        <p className="welcome-footnote">Gmail, Outlook, iCloud, Fastmail, Yahoo, AOL and other IMAP mail.</p>
      </>)}
      {step==='account'&&<div className="onboarding-account add-account">
        <AddAccountForm setup capabilities={capabilities} header={title=><h2>{title}</h2>} connected={()=>{void refresh().then(()=>setStep('start'));}}/>
      </div>}
      {step==='ai'&&<AiStep settings={state.settings} onSettings={patch=>void invoke('settings.update',{patch}).then(refresh)} onNext={next}/>}
      {step==='mic'&&<MicStep desktop={capabilities.desktop} onNext={next}/>}
      {step==='sync'&&<SyncStep onFinish={()=>void finish()}/>}
    </main>
    <footer className="onboarding-foot">
      <span className="onboarding-dots" role="img" aria-label={`Step ${index+1} of ${dots.length}`}>{dots.map((s,i)=><i key={s} className={cx(i===index&&'is-current',i<index&&'is-past')}/>)}</span>
      {hint&&<span className="onboarding-skip"><Kbd size="sm">esc</Kbd>{hint}</span>}
    </footer>
  </div>;
}

/**
 * The last screen: every account's first sync (threads fetched of the target where the host can count), then AI over the
 * newest Home mail. It opens the app when both are done; a failure shows the host's own words with Retry or Continue.
 */
function SyncStep({onFinish:finish}:{onFinish:()=>void}){
  // Background AI keeps the state changing, so the parent re-renders often; the callback is read through a ref so the
  // timer below is not restarted by every render.
  const finishRef=useRef(finish);finishRef.current=finish;const onFinish=useCallback(()=>finishRef.current(),[]);
  const [progress,setProgress]=useState<SetupProgress>();const [running,setRunning]=useState(0);const [fatal,setFatal]=useState('');const retry=useRef<HTMLButtonElement>(null);
  useEffect(()=>bridge.subscribe(event=>{if(event.type==='setup.progress')setProgress(event.payload as SetupProgress);}),[]);
  useEffect(()=>{let live=true;
    void invoke<SetupProgress>('setup.status').then(p=>{if(live)setProgress(current=>current??p);}).catch(()=>{});
    void invoke<SetupProgress>('setup.run').then(p=>{if(live)setProgress(p);}).catch(e=>{if(live){setFatal((e as Error).message);setProgress(current=>({state:'failed',accounts:current?.accounts??[]}));}});
    return ()=>{live=false;};},[running]);
  const state=progress?.state??'syncing',failed=state==='failed',done=state==='done';
  // A short beat on "ready" so the change is seen, then the app.
  useEffect(()=>{if(!done)return;const t=setTimeout(onFinish,700);return ()=>clearTimeout(t);},[done,onFinish]);
  // Retry appears within this screen, so it takes focus itself: Enter retries, Escape continues.
  useEffect(()=>{if(failed)retry.current?.focus({preventScroll:true});},[failed]);
  useEffect(()=>{if(!failed)return;const key=(e:KeyboardEvent)=>{if(e.key==='Escape'&&!e.defaultPrevented){e.preventDefault();onFinish();}};addEventListener('keydown',key);return ()=>removeEventListener('keydown',key);},[failed,onFinish]);
  const ai=progress?.ai;
  const title=failed?'Some mail didn’t come through':done?'Your mail is ready':state==='summarizing'?'Reading your newest mail':'Getting your mail ready';
  return <>
    <AppIcon size={56}/>
    <h2>{title}</h2>
    <p>{failed?'Aplos could not finish syncing. You can try again, or start with what has arrived.':done?'Opening Aplos…':'This happens once. Your mail stays on this Mac.'}</p>
    <ul className="setup-progress" aria-live="polite">
      {(progress?.accounts??[]).map(a=><li key={a.accountId} className={cx('setup-row','is-'+a.phase)}>
        <div className="setup-row-head"><span className="setup-row-name">{a.email}</span><span className="setup-row-status">{rowStatus(a)}</span></div>
        {(a.phase==='mail'||a.phase==='calendar'||a.phase==='waiting')&&<Bar value={a.phase==='calendar'?1:a.target?(a.fetched??0)/a.target:undefined}/>}
        {a.phase==='error'&&a.error&&<p className="setup-row-error">{a.error}</p>}
      </li>)}
      {ai&&ai.state!=='skipped'&&ai.total>0&&<li className={cx('setup-row','is-ai',ai.state==='running'?'is-mail':'is-done')}>
        <div className="setup-row-head"><span className="setup-row-name">Summaries for Home</span><span className="setup-row-status">{ai.state==='running'?`${ai.done} of ${ai.total}`:<><Check size={12}/>Done</>}</span></div>
        {ai.state==='running'&&<Bar value={ai.total?ai.done/ai.total:undefined}/>}
      </li>}
    </ul>
    {fatal&&<p className="setup-row-error">{fatal}</p>}
    {ai?.state==='skipped'&&<p className="setup-note">No AI provider is set up, so summaries will start once you add a key in Settings → AI.</p>}
    {ai&&ai.state!=='skipped'&&(ai.background>0||ai.state==='partial')&&<p className="setup-note">Older mail keeps being summarized in the background.</p>}
    {failed?<div className="onboarding-actions">
      <Button variant="text" shortcut="esc" onClick={onFinish}>Continue to Aplos</Button>
      <Button ref={retry} variant="primary" icon={RefreshCw} onClick={()=>{setFatal('');setProgress(p=>p&&{...p,state:'syncing'});setRunning(n=>n+1);}}>Retry</Button>
    </div>:!done&&<dl className="onboarding-keys is-quiet">
      <div><dt><Kbd>Space</Kbd></dt><dd>Do what the email asks</dd></div>
      <div><dt><Kbd>A</Kbd></dt><dd>Ask anything. Hold it to talk</dd></div>
      <div><dt><Keys combo="J K"/></dt><dd>Next and previous email</dd></div>
    </dl>}
  </>;
}
function rowStatus(a:SetupProgress['accounts'][number]){
  if(a.phase==='waiting')return 'Waiting';
  if(a.phase==='mail')return a.target?`${a.fetched??0} of ${a.target}`:<><Spinner size={11}/>Downloading</>;
  if(a.phase==='calendar')return 'Calendar';
  if(a.phase==='error')return 'Didn’t sync';
  return <><Check size={12}/>Synced</>;
}
/** A thin progress bar; without a value it shows quiet indeterminate motion. */
function Bar({value}:{value?:number}){
  return <span className={cx('setup-bar',value===undefined&&'is-indeterminate')} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={value===undefined?undefined:Math.round(value*100)}><i style={value===undefined?undefined:{width:`${Math.max(2,Math.min(100,value*100))}%`}}/></span>;
}

/** A provider and its key, Groq first. Saving a key for another provider while Groq has none moves the text features to it. */
function AiStep({settings,onSettings,onNext}:{settings:Settings;onSettings:(patch:Partial<Settings>)=>void;onNext:()=>void}){
  const {store,update}=useKeyStore();const [id,setId]=useState<AskProviderId>('groq');
  const info=store?.providers[id]??{},ready=!!info.source,groqReady=!!store?.providers.groq?.source;
  const p=askProvider(id),moves=id!=='groq'&&ready&&!groqReady;
  function go(){
    if(moves){
      const model=`${id}:${p.models[0]!.id}`,patch:Partial<Record<AiModelSetting,string>>={};
      for(const f of aiFeatures)if(f.id!=='voice'&&settings[f.setting].startsWith('groq:'))patch[f.setting]=model;
      if(voiceProviders[id]&&settings.voiceModel.startsWith('groq:'))patch.voiceModel=`${id}:${voiceProviders[id]![0].id}`;
      onSettings(patch);
    }
    onNext();
  }
  return <>
    <span className="onboarding-glyph"><KeyRound size={19}/></span>
    <h2>Connect an AI provider</h2>
    <p>Summaries, Ask, drafts and voice run on a provider you choose, with your own key. Groq is fast and has a free plan.</p>
    <div className="onboarding-form">
      <div className="onboarding-provider"><span>Provider</span><Select label="AI provider" variant="field" value={id} options={keyed.map(k=>[k,askProvider(k).label] as [AskProviderId,string])} onChange={value=>setId(value)}/></div>
      {store?<ApiKeyField key={id} provider={id} info={info} store={store} onChange={next=>update(id,next)} autoFocus/>:<span className="onboarding-loading"><Spinner size={13}/></span>}
      <p className="onboarding-hint">{moves?`Ask, Summaries, Drafts and Plans will use ${p.label}. You can change each in Settings → AI.`:'Ollama, LM Studio and your own server are in Settings → AI.'}</p>
    </div>
    <div className="onboarding-actions">
      <Button variant="text" onClick={onNext}>Skip for now</Button>
      <Button variant="primary" iconRight={ArrowRight} disabled={!ready} data-autofocus={ready||undefined} onClick={go}>Continue</Button>
    </div>
  </>;
}

/** Hold-to-talk, and the microphone permission now or later. The status check never shows the macOS prompt by itself. */
function MicStep({desktop,onNext}:{desktop:boolean;onNext:()=>void}){
  const [mic,setMic]=useState<Microphone>('unknown');
  useEffect(()=>{let live=true;
    const set=(value:Microphone)=>{if(live)setMic(value);};
    if(desktop)void invoke<{status:Microphone}>('system.microphone',{check:true}).then(r=>set(r.status)).catch(()=>{});
    else void navigator.permissions?.query({name:'microphone' as PermissionName}).then(r=>set(r.state==='prompt'?'not-determined':r.state)).catch(()=>{});
    return()=>{live=false;};},[desktop]);
  async function ask(){
    setMic('asking');
    try{
      if(desktop){const result=await invoke<{granted:boolean;status:Microphone}>('system.microphone');setMic(result.granted?'granted':result.status==='not-determined'?'not-determined':'denied');}
      else{const stream=await navigator.mediaDevices.getUserMedia({audio:true});stream.getTracks().forEach(t=>t.stop());setMic('granted');}
    }catch{setMic('denied');}
  }
  const granted=mic==='granted',blocked=mic==='denied'||mic==='restricted';
  return <>
    <span className="onboarding-glyph"><Mic size={19}/></span>
    <h2>Talk instead of typing</h2>
    <p>Hold <Kbd size="sm">A</Kbd> to ask out loud, or hold <Kbd size="sm">Space</Kbd> in a reply to dictate. Let go and Aplos writes it out.</p>
    <p className={cx('onboarding-status',granted&&'is-ok',blocked&&'is-blocked')} role="status" aria-live="polite">
      {granted?<><span className="ai-check-mark"><Check size={10}/></span>The microphone is ready.</>
        :blocked?'macOS is blocking the microphone. Turn on Aplos Mail in System Settings → Privacy & Security → Microphone.'
        :'Aplos only listens while you hold the key. Recordings go to your Voice model and aren’t kept.'}
    </p>
    <div className="onboarding-actions">
      {granted?<Button variant="primary" iconRight={ArrowRight} data-autofocus onClick={onNext}>Continue</Button>:<>
        <Button variant="text" onClick={onNext}>Later</Button>
        <Button variant="primary" icon={Mic} loading={mic==='asking'} data-autofocus onClick={()=>void ask()}>{blocked?'Try again':'Allow microphone'}</Button>
      </>}
    </div>
  </>;
}
