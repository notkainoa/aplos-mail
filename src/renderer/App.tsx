import {useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {Bookmark,Check,CheckCheck,CircleCheck,Clock,CornerUpLeft,ExternalLink,FileText,Layers,MailOpen,MessageCircle,Search,Send,ShieldAlert,Trash2,WifiOff,X} from './icons';
import type {AppState,CalendarEvent,Capabilities,Draft,Settings as Preferences,Thread,View} from '../shared/types';
import {bridge,escapeHtml,invoke,replyRecipients,uid} from './bridge';
import {Compose,addressOf,validAddress,type Contact} from './Compose';
import {Ask} from './Ask';
import {Reader} from './Reader';
import {Calendar,EventEditor} from './Calendar';
import {Settings} from './Settings';
import {Sidebar,sections} from './components/Sidebar';
import {Topbar} from './components/Topbar';
import {DraftList,MailSection,highlightTerms,type RowHandlers,type Triage} from './components/MailList';
import {ComposeSkeleton,DuePopover,PendingSends,ShortcutsDialog,WelcomeDialog} from './components/Overlays';
import {Button,Checkbox,ConfirmHost,EmptyState,IconButton,Keys,Menu,Spinner,Tabs,Toaster,confirmAction,cx,dialogOpen,hintExit,reducedMotion,toast,useMenu,usePresence,type Icon} from './ui';

const titles:Record<View,string>={home:'Home',later:'Later',all:'All mail',drafts:'Drafts',sent:'Sent','needs-reply':'Needs reply','awaiting-reply':'Awaiting reply',trash:'Trash',spam:'Spam',low:'Low importance',calendar:'Calendar',settings:'Settings'};
const empties:Partial<Record<View,{icon:Icon;title:string;detail?:string}>>={
  home:{icon:CircleCheck,title:'All clear for now',detail:'New mail that matters will land here.'},
  later:{icon:Clock,title:'Nothing saved for later',detail:'Press ← on an email to keep it as a Todo.'},
  drafts:{icon:FileText,title:'No drafts',detail:'Press C to start writing.'},
  'needs-reply':{icon:CornerUpLeft,title:'Nobody is waiting on you'},
  'awaiting-reply':{icon:MessageCircle,title:'Not waiting on anyone'},
  sent:{icon:Send,title:'Nothing sent yet'},
  trash:{icon:Trash2,title:'Trash is empty'},
  spam:{icon:ShieldAlert,title:'No spam'},
  low:{icon:Layers,title:'No low-importance mail'},
  all:{icon:MailOpen,title:'No mail here yet'},
};
const mac=/Mac/.test(navigator.userAgent);
const askStorageKey='aplos.askPanel';const recentSearchKey='aplos.recentSearches';
const askExamples=['What plans do I have this week?','Which emails still need a reply?','Summarize what changed today.','Draft a friendly follow-up.'];
const queryParams=new URLSearchParams(location.search);const popoutDraft=queryParams.get('draft');const popoutThread=queryParams.get('thread');
type Route={view:View;threadId?:string};
const triageLabels:Record<Triage,string>={done:'Marked done',later:'Moved to Todo',trash:'Moved to Trash',spam:'Moved to Spam'};
const noop=()=>{};

export function App(){
 const [state,setState]=useState<AppState>();
 const [capabilities,setCapabilities]=useState<Capabilities>({groq:false,google:false,desktop:!!window.aplos,version:'0.1.0'});
 const [fatal,setFatal]=useState('');
 const [route,setRoute]=useState<Route>({view:'home',threadId:popoutThread??undefined});
 const [routes,setRoutes]=useState<Route[]>([{view:'home'}]);const [historyIndex,setHistoryIndex]=useState(0);
 const [ask,setAsk]=useState(()=>!popoutThread&&localStorage.getItem(askStorageKey)!=='closed');
 const [composer,setComposer]=useState<Draft>();const [liveDraft,setLiveDraft]=useState<Draft>();const [composeClosing,setComposeClosing]=useState(false);const [draftBlocked,setDraftBlocked]=useState(false);
 const [laterTab,setLaterTab]=useState<'todos'|'bookmarks'>('todos');
 const [selected,setSelected]=useState<Set<string>>(new Set());
 const [search,setSearch]=useState('');const [searchMode,setSearchMode]=useState(false);const [searchResults,setSearchResults]=useState<Thread[]>([]);const [searching,setSearching]=useState(false);const [searchedFor,setSearchedFor]=useState('');
 const [shortcutHelp,setShortcutHelp]=useState(false);
 const [eventEditor,setEventEditor]=useState<Partial<CalendarEvent>|null>(null);
 const [online,setOnline]=useState(navigator.onLine);const [now,setNow]=useState(Date.now());
 const [busy,setBusy]=useState('');const [welcomeError,setWelcomeError]=useState('');
 const [leaving,setLeaving]=useState<{thread:Thread;status:Triage;key:number}>();
 const [entering,setEntering]=useState<{id:string;from:string}>();
 const [duePrompt,setDuePrompt]=useState<{id:string;key:number}>();
 const rowMenu=useMenu();const [menuThread,setMenuThread]=useState<Thread>();
 const freshDraft=useRef('');const hoveredId=useRef<string|null>(null);const talkHeld=useRef(false);
 const spaceHold=useRef<{timer?:ReturnType<typeof setTimeout>;fired:boolean}|null>(null);
 const lastTriage=useRef<{id:string;status:Triage;reopen:boolean}|null>(null);
 const searchInput=useRef<HTMLInputElement>(null);const eventHandler=useRef<(event:{type:string;payload?:unknown})=>void>(()=>{});
 const searchSeq=useRef(0);const composeRef=useRef<Draft|undefined>(undefined);composeRef.current=composer;
 const undoRef=useRef<()=>void>(noop);
 // `shown` is false while the pointer drives the list, so the hover highlight is the only cue.
 const [cursor,setCursor]=useState<{id?:string;shown:boolean}>({shown:false});
 const [recentSearches,setRecentSearches]=useState<string[]>(()=>{try{const saved=JSON.parse(localStorage.getItem(recentSearchKey)||'[]');return Array.isArray(saved)?saved.filter(q=>typeof q==='string').slice(0,5):[];}catch{return [];}});
 const selectAnchor=useRef<string|null>(null);const listRef=useRef<HTMLDivElement>(null);const listScroll=useRef(0);

 function notify(text:string,undoable=false){toast.show({text,action:undoable?{label:'Undo',shortcut:'Z',run:()=>undoRef.current()}:undefined});}
 function fail(error:unknown){toast.show({text:error instanceof Error?error.message:String(error),tone:'error'});}
 const refresh=useCallback(async()=>{try{setState(await invoke<AppState>('state.get'));setFatal('');}catch(e){setFatal((e as Error).message);}},[]);
 useEffect(()=>{
  void refresh();void invoke<Capabilities>('capabilities.get').then(setCapabilities).catch(()=>{});
  const unsubscribe=bridge.subscribe(e=>eventHandler.current(e));const t=setInterval(()=>setNow(Date.now()),1000);
  const up=()=>setOnline(true);const down=()=>setOnline(false);addEventListener('online',up);addEventListener('offline',down);
  return ()=>{unsubscribe();clearInterval(t);removeEventListener('online',up);removeEventListener('offline',down);};
 },[]);
 useEffect(()=>{if(!popoutThread)localStorage.setItem(askStorageKey,ask?'open':'closed');},[ask]);
 useEffect(()=>{if(!leaving)return;const t=setTimeout(()=>setLeaving(undefined),340);return ()=>clearTimeout(t);},[leaving?.key]);
 useEffect(()=>{if(!duePrompt)return;const t=setTimeout(()=>setDuePrompt(undefined),7000);return ()=>clearTimeout(t);},[duePrompt?.key]);
 useEffect(()=>{if(!state)return;const theme=state.settings.theme;const media=matchMedia('(prefers-color-scheme: dark)');const apply=()=>document.documentElement.dataset.theme=theme==='system'?(media.matches?'dark':'light'):theme;apply();media.addEventListener('change',apply);return ()=>media.removeEventListener('change',apply);},[state?.settings.theme]);
 useEffect(()=>{if(!popoutDraft||!state||composer||draftBlocked)return;const draft=state.drafts.find(d=>d.id===popoutDraft);if(draft)void invoke<boolean>('window.claim',{draftId:draft.id}).then(ok=>ok?setComposer(draft):setDraftBlocked(true)).catch(e=>setFatal(e.message));},[!!state,popoutDraft]);

 function replyGuard(){if(!inlineReply)return false;notify('Send or close your reply first.');return true;}
 function navigate(view:View,threadId?:string){if(replyGuard())return;const next={view,threadId};setRoute(next);setSearchMode(false);setSelected(new Set());setRoutes(prev=>[...prev.slice(0,historyIndex+1),next]);setHistoryIndex(i=>i+1);}
 function historyMove(delta:number){if(replyGuard())return;const index=historyIndex+delta;if(index<0||index>=routes.length)return;setHistoryIndex(index);setRoute(routes[index]);setSelected(new Set());setSearchMode(false);}
 async function updateSettings(patch:Partial<Preferences>){try{await invoke('settings.update',{patch});}catch(e){fail(e);}}
 async function patch(ids:string[],p:Partial<Thread>,label?:string,keepTriage=false){if(!keepTriage)lastTriage.current=null;try{await invoke('thread.update',{ids,patch:p});if(label)notify(label,true);setSelected(new Set());}catch(e){fail(e);}}
 async function undo(){
  const last=lastTriage.current;lastTriage.current=null;setDuePrompt(undefined);toast.dismissActions();
  try{await invoke('thread.undo');
   if(last?.reopen&&!inlineReply){setLeaving(undefined);if(!reducedMotion())setEntering({id:last.id,from:last.status==='done'?'right':last.status==='later'?'left':'below'});setRoute(r=>({...r,threadId:last.id}));}
   else notify('Action undone');
  }catch(e){fail(e);}
 }
 undoRef.current=()=>void undo();
 async function sync(){setBusy('sync');try{await invoke('sync',{accountId:state?.selectedAccountId==='all'?undefined:state?.selectedAccountId});}catch(e){fail(e);}finally{setBusy('');}}
 async function openDraft(draft:Draft){try{if(draft.pendingSendAt){notify('Undo sending before editing this draft.');return;}if(composer&&composer.id!==draft.id){nudgeComposer();return;}const claimed=await invoke<boolean>('window.claim',{draftId:draft.id});if(!claimed){notify('This draft is open in another window.');return;}setComposer(draft);}catch(e){fail(e);}}
 async function newDraft(proposal:Partial<Draft>={},thread?:Thread,mode:Draft['mode']='new'){
  if(!state)return;if(composer){nudgeComposer();return;}
  const last=thread?.messages.at(-1);const a=state.accounts.find(a=>a.id===(thread?.accountId||state.selectedAccountId))||state.accounts[0];if(!a){notify('Connect an account to write email.');return;}
  let html='';let to='';let cc='';let subject='';
  if(thread&&last){subject=(mode==='forward'?'Fwd: ':'Re: ')+thread.subject.replace(/^(Re|Fwd):\s*/i,'');if(mode==='forward')html=`<p><br></p><blockquote><p>Forwarded message from ${escapeHtml(last.fromName)} &lt;${escapeHtml(last.from)}&gt;</p><p>${escapeHtml(last.text).replace(/\n/g,'<br>')}</p></blockquote>`;else if(mode!=='new')({to,cc}=replyRecipients(thread,a.email,mode));}
  const alias=a.sendAs?.find(sender=>thread&&last?.to.some(address=>address.toLowerCase().includes(sender.email.toLowerCase())))||a.sendAs?.find(sender=>sender.isDefault)||a.sendAs?.find(sender=>sender.email===a.email);
  const d:Draft={id:uid(),accountId:a.id,to,cc,bcc:'',subject,html,attachments:[],mode,signature:true,...(a.provider==='google'?{fromEmail:alias?.email||a.email,signatureSource:alias?'gmail' as const:'custom' as const}:{}),updatedAt:new Date().toISOString(),revision:0,...(thread&&mode!=='forward'?{threadId:thread.id}:{}),...proposal};
  setBusy(thread&&mode!=='forward'?'reply':'draft');
  try{if(thread&&mode==='forward')d.attachments=await Promise.all(thread.messages.at(-1)!.attachments.map(a=>a.data?Promise.resolve(a):invoke<import('../shared/types').Attachment>('attachment.get',{threadId:thread.id,attachmentId:a.id})));const saved=await invoke<Draft>('draft.save',{draft:d});freshDraft.current=saved.id;await openDraft(saved);}catch(e){fail(e);}finally{setBusy('');}
 }
 function nudgeComposer(){dispatchEvent(new Event('aplos:compose-nudge'));notify('Finish or close this draft to start another.');}
 function closeCompose(){const id=composer?.id;const done=()=>{setComposer(undefined);setLiveDraft(undefined);setComposeClosing(false);if(id)void invoke('window.release',{draftId:id}).catch(()=>{});if(popoutDraft)window.close();};if(!inlineReply&&!popoutDraft&&!reducedMotion()){setComposeClosing(true);setTimeout(done,150);}else done();}
 async function searchMail(value:string){const seq=++searchSeq.current;if(!value.trim()){setSearchResults([]);setSearching(false);return;}setSearching(true);try{const result=await invoke<Thread[]>('search',{query:value,accountId:state?.selectedAccountId});if(searchSeq.current===seq){setSearchResults(result);setSearchedFor(value);}}catch(e){if(searchSeq.current===seq)fail(e);}finally{if(searchSeq.current===seq)setSearching(false);}}
 useEffect(()=>{if(!searchMode)return;const t=setTimeout(()=>void searchMail(search),250);return ()=>clearTimeout(t);},[search,searchMode,state?.selectedAccountId]);
 const scoped=useMemo(()=>state?.threads.filter(t=>state.selectedAccountId==='all'||t.accountId===state.selectedAccountId).sort((a,b)=>b.date.localeCompare(a.date))??[],[state?.threads,state?.selectedAccountId]);
 const filtered=useMemo(()=>{
  if(searchMode)return searchResults;
  const v=route.view;return scoped.filter(t=>v==='home'?t.status==='new'&&t.importance==='important'&&!t.hiddenFromHome:v==='later'?laterTab==='bookmarks'?t.bookmarked&&t.status!=='trash'&&t.status!=='spam':t.status==='later':v==='low'?t.importance==='low'&&t.status==='new':v==='needs-reply'||v==='awaiting-reply'?t.replyStatus===v&&t.status!=='trash'&&t.status!=='spam':v==='all'?t.status!=='trash'&&t.status!=='spam':v==='sent'?t.messages.some(m=>m.sent):v==='trash'||v==='spam'?t.status===v:false);
 },[scoped,route.view,laterTab,searchMode,searchResults]);
 // People this mailbox has exchanged mail with, most frequent first, for recipient suggestions.
 const contacts=useMemo(()=>{
  const own=new Set(state?.accounts.flatMap(a=>[a.email,...(a.sendAs??[]).map(s=>s.email)]).map(e=>e.toLowerCase()));
  const seen=new Map<string,Contact&{count:number;last:string}>();
  const add=(raw:string,name:string,date:string)=>{const email=addressOf(raw);const key=email.toLowerCase();if(!validAddress(email)||own.has(key))return;const named=name||/^\s*"?([^"<]+?)"?\s*</.exec(raw)?.[1]||'';const entry=seen.get(key);if(entry){entry.count++;if(date>entry.last)entry.last=date;if(!entry.name&&named)entry.name=named;}else seen.set(key,{email,name:named,count:1,last:date});};
  for(const t of state?.threads??[])for(const m of t.messages){add(m.from,m.fromName,m.date);for(const to of [...m.to,...(m.cc??[])])add(to,'',m.date);}
  return [...seen.values()].sort((a,b)=>b.count-a.count||b.last.localeCompare(a.last)).map(({email,name})=>({email,name}));
 },[state?.threads,state?.accounts]);
 const buckets=useMemo(()=>{
  const today=new Date().toISOString().slice(0,10);const later=scoped.filter(t=>t.status==='later');
  return {today,later,low:scoped.filter(t=>t.status==='new'&&t.importance==='low'),
   homeLater:later.filter(t=>!t.hiddenFromHome&&(!t.dueDate||t.dueDate<=today)),
   replyHome:scoped.filter(t=>t.replyStatus==='needs-reply'&&t.status==='done'&&!t.hiddenFromHome)};
 },[scoped]);
 // The order rows appear on screen, so j/k, ⇧-click ranges and the reader stack all walk the same sequence.
 const order=useMemo(()=>{
  if(searchMode)return filtered;
  if(route.view==='home')return [...filtered,...buckets.homeLater,...buckets.replyHome];
  if(route.view==='later'&&laterTab==='todos'){const today=buckets.today;return [...filtered.filter(t=>t.dueDate&&t.dueDate<today),...filtered.filter(t=>!t.dueDate),...filtered.filter(t=>t.dueDate&&t.dueDate>=today)];}
  return filtered;
 },[filtered,buckets,route.view,laterTab,searchMode]);
 const searchHints=useMemo(()=>{
  if(!searchMode)return [];
  const hints:string[]=[];const counts=new Map<string,number>();
  for(const t of scoped)for(const m of t.messages)if(!m.sent){const first=(m.fromName||m.from).split(/[\s@]/)[0].toLowerCase();if(first)counts.set(first,(counts.get(first)??0)+1);}
  if(scoped.some(t=>t.unread))hints.push('is:unread');
  if(scoped.some(t=>t.messages.some(m=>m.attachments.length)))hints.push('has:attachment');
  if(scoped.some(t=>t.bookmarked))hints.push('is:bookmarked');
  const top=[...counts].sort((a,b)=>b[1]-a[1])[0];if(top)hints.push('from:'+top[0]);
  return hints;
 },[scoped,searchMode]);
 const selectedThread=state?.threads.find(t=>t.id===route.threadId)||searchResults.find(t=>t.id===route.threadId);const readerIndex=Math.max(0,order.findIndex(t=>t.id===route.threadId));
 const inlineReply=!!composer&&!!selectedThread&&!popoutDraft&&!popoutThread&&composer.threadId===selectedThread.id&&composer.mode!=='new'&&composer.mode!=='forward';
 function openThread(id:string){if(inlineReply&&id!==selectedThread?.id){notify('Send or close your reply first.');return;}setRoute(r=>({...r,threadId:id}));const t=state?.threads.find(t=>t.id===id);if(t?.unread)void invoke('thread.update',{ids:[id],patch:{unread:false},recordUndo:false}).catch(fail);}
 function nextThread(delta:number){const next=order[readerIndex+delta];if(next)openThread(next.id);}
 function moveCursor(delta:number){
  if(!order.length)return;const at=order.findIndex(t=>t.id===cursor.id);
  const index=at<0?(delta>0?0:order.length-1):cursor.shown||hoveredId.current?Math.min(order.length-1,Math.max(0,at+delta)):at;
  setCursor({id:order[index].id,shown:true});
 }
 function selectRow(thread:Thread,how:'toggle'|'range'='toggle'){
  const anchor=selectAnchor.current;const from=anchor?order.findIndex(t=>t.id===anchor):-1;const to=order.findIndex(t=>t.id===thread.id);
  setSelected(prev=>{const next=new Set(prev);
   if(how==='range'&&from>=0&&to>=0){for(const t of order.slice(Math.min(from,to),Math.max(from,to)+1))next.add(t.id);}
   else next.has(thread.id)?next.delete(thread.id):next.add(thread.id);
   return next;});
  selectAnchor.current=thread.id;
 }
 function exitDirection(status:Triage){const doneLeft=state?.settings.triageDirection==='done-left';return status==='done'?(doneLeft?'left':'right'):status==='later'?(doneLeft?'right':'left'):'down';}
 function triage(thread:Thread,status:Triage){
  const current=thread.id===selectedThread?.id;const stack=state?.settings.openMode==='stack';
  hintExit(thread.id,exitDirection(status));
  // The stack dock has its own undo button, so the toast would only cover it.
  void patch([thread.id],{status},current&&stack?undefined:triageLabels[status],true);
  lastTriage.current={id:thread.id,status,reopen:current};
  setDuePrompt(status==='later'?{id:thread.id,key:Date.now()}:undefined);setEntering(undefined);
  // Right after an undo the reopened thread may not be back in the list yet, so fall back to its date position.
  const at=order.findIndex(t=>t.id===thread.id);
  const following=at>=0?order[at+1]||order[at-1]:order.find(t=>t.date<=thread.date)||order.at(-1);
  if(!current){if(cursor.id===thread.id)setCursor(c=>({...c,id:following?.id}));return;}
  if(stack&&!reducedMotion())setLeaving({thread,status,key:Date.now()});
  if(following&&following.id!==thread.id)setRoute(r=>({...r,threadId:following.id}));else setRoute(r=>({...r,threadId:undefined}));
  if(following?.unread)void invoke('thread.update',{ids:[following.id],patch:{unread:false},recordUndo:false}).catch(()=>{});
 }
 function bulk(status:Triage,label:string){const ids=[...selected];for(const id of ids)hintExit(id,exitDirection(status));if(cursor.id&&selected.has(cursor.id)){const at=order.findIndex(t=>t.id===cursor.id);setCursor(c=>({...c,id:order.slice(at+1).find(t=>!selected.has(t.id))?.id}));}void patch(ids,{status},`${label} · ${ids.length} email${ids.length===1?'':'s'}`);}
 function talk(phase:'start'|'release'){
  if(phase==='start'){
   if(talkHeld.current||!selectedThread)return;talkHeld.current=true;
   const release=()=>{removeEventListener('pointerup',release);talk('release');};addEventListener('pointerup',release);
   void newDraft({},selectedThread,state?.settings.defaultReply);
  }else if(talkHeld.current){talkHeld.current=false;dispatchEvent(new Event('aplos:talk-release'));}
 }
 async function setDue(id:string,dueDate:string,label:string){setDuePrompt(undefined);try{await invoke('thread.update',{ids:[id],patch:{dueDate},recordUndo:false});notify(label);}catch(e){fail(e);}}
 function openSearch(){if(replyGuard())return;setSearchMode(true);setRoute(r=>({...r,threadId:undefined}));setTimeout(()=>searchInput.current?.focus(),20);}
 function closeSearch(){setSearchMode(false);setSearch('');}
 function rememberSearch(query:string){const value=query.trim();if(!value)return;setRecentSearches(prev=>{const next=[value,...prev.filter(q=>q!==value)].slice(0,5);localStorage.setItem(recentSearchKey,JSON.stringify(next));return next;});}
 function searchKeys(e:React.KeyboardEvent<HTMLInputElement>){
  if(e.key==='Escape'){e.preventDefault();e.stopPropagation();if(search)setSearch('');else closeSearch();}
  else if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();moveCursor(e.key==='ArrowDown'?1:-1);}
  else if(e.key==='Enter'&&!e.nativeEvent.isComposing){const target=order.find(t=>t.id===cursor.id&&cursor.shown)||order[0];if(target){e.preventDefault();rememberSearch(search);openThread(target.id);}}
 }
 function command(command:string){if(command.startsWith('thread:')){navigate('all',command.slice(7));return;}switch(command){case'compose':void newDraft();break;case'settings':navigate('settings');break;case'search':openSearch();break;case'ask':setAsk(v=>!v);break;case'shortcuts':setShortcutHelp(true);break;case'toggle-sidebar':void updateSettings({sidebar:!state?.settings.sidebar});break;case'back':historyMove(-1);break;case'forward':historyMove(1);break;case'refresh':void sync();break;case'undo':void undo();break;default:if(sections.some(s=>s.view===command))navigate(command as View);}}
 eventHandler.current=event=>{
  if(event.type==='state')setState(event.payload as AppState);
  else if(event.type==='prepare-close'){if(!composeRef.current)void invoke('window.closeReady').catch(()=>{});}
  else if(event.type==='command')command(String(event.payload));
  else if(event.type==='deep-link'){try{const url=new URL(String(event.payload));if(url.protocol==='mailto:')void newDraft({to:decodeURIComponent(url.pathname),subject:url.searchParams.get('subject')||'',html:escapeHtml(url.searchParams.get('body')||'').replace(/\n/g,'<br>'),cc:url.searchParams.get('cc')||'',bcc:url.searchParams.get('bcc')||''});else if(url.host==='compose')void newDraft({to:url.searchParams.get('to')||'',subject:url.searchParams.get('subject')||'',html:escapeHtml(url.searchParams.get('body')||'')});else if(url.host==='settings')navigate('settings');else if(url.host==='thread')navigate('all',decodeURIComponent(url.pathname.slice(1)));}catch{notify('That link could not be opened.');}}
  else if(event.type==='sent'){notify('Message sent');if((event.payload as {playSound?:boolean})?.playSound){try{const ctx=new AudioContext();const osc=ctx.createOscillator();const gain=ctx.createGain();osc.connect(gain);gain.connect(ctx.destination);osc.frequency.setValueAtTime(540,ctx.currentTime);osc.frequency.exponentialRampToValueAtTime(810,ctx.currentTime+.12);gain.gain.setValueAtTime(.035,ctx.currentTime);gain.gain.exponentialRampToValueAtTime(.001,ctx.currentTime+.22);osc.start();osc.stop(ctx.currentTime+.23);osc.onended=()=>void ctx.close();}catch{/* no sound without audio permission */}}}
  else if(event.type==='send-error'||event.type==='error')toast.show({tone:'error',text:typeof event.payload==='string'?event.payload:(event.payload as {message?:string})?.message||'Something needs your attention.'});
  else if(event.type==='reminder')notify('Reminder: '+(event.payload as {title:string}).title);
 };
 useEffect(()=>{
  function keyboard(e:KeyboardEvent){
   const element=e.target as HTMLElement;const typing=['INPUT','TEXTAREA','SELECT'].includes(element.tagName)||element.isContentEditable;
   if(dialogOpen())return;
   if((e.metaKey||e.ctrlKey)&&['k','j',',','/'].includes(e.key)){e.preventDefault();command(e.key==='k'?'search':e.key==='j'?'ask':e.key===','?'settings':'shortcuts');return;}
   if(e.ctrlKey&&!e.metaKey&&!e.altKey&&/^[1-9]$/.test(e.key)&&!composer){const section=sections[Number(e.key)-1];if(section){e.preventDefault();navigate(section.view);}return;}
   if(composer||eventEditor||typing)return;
   if(e.key==='Escape'){setDuePrompt(undefined);if(selected.size){setSelected(new Set());return;}if(selectedThread){if(!replyGuard())setRoute(r=>({...r,threadId:undefined}));}else if(searchMode){setSearchMode(false);setSearch('');}else if(cursor.shown)setCursor(c=>({...c,shown:false}));return;}
   if((e.metaKey||e.ctrlKey)&&e.key==='a'&&!selectedThread&&order.length){e.preventDefault();setSelected(new Set(order.map(t=>t.id)));return;}
   if(e.metaKey||e.ctrlKey||e.altKey)return;
   const t=selectedThread;const pointed=!t?order.find(x=>x.id===(hoveredId.current||(cursor.shown?cursor.id:undefined))):undefined;const subject=t||pointed;
   if(e.key===' '&&t){e.preventDefault();if(e.repeat||spaceHold.current)return;const hold:{timer?:ReturnType<typeof setTimeout>;fired:boolean}={fired:false};hold.timer=setTimeout(()=>{hold.fired=true;talk('start');},300);spaceHold.current=hold;return;}
   const keys:Record<string,()=>void>={c:()=>void newDraft(),a:()=>setAsk(true),'/':()=>command('search'),'?':()=>setShortcutHelp(true),'[':()=>command('toggle-sidebar'),z:()=>void undo(),s:()=>{const first=pointed||order[0];if(first)openThread(first.id);}};
   // Arrow keys keep scrolling the message while the reader is open.
   if(t){keys.j=()=>nextThread(1);keys.k=()=>nextThread(-1);}
   else if(!['settings','calendar'].includes(route.view)){keys.j=keys.ArrowDown=()=>moveCursor(1);keys.k=keys.ArrowUp=()=>moveCursor(-1);}
   if(pointed){keys.Enter=keys.o=()=>openThread(pointed.id);keys.x=()=>selectRow(pointed,e.shiftKey?'range':'toggle');keys.X=keys.x;}
   if(subject){const doneLeft=state?.settings.triageDirection==='done-left';keys.e=()=>triage(subject,'done');keys.l=()=>triage(subject,'later');keys.b=()=>void patch([subject.id],{bookmarked:!subject.bookmarked},subject.bookmarked?'Bookmark removed':'Bookmarked');keys.u=()=>void patch([subject.id],{unread:!subject.unread});keys['#']=()=>triage(subject,'trash');keys.ArrowLeft=()=>triage(subject,doneLeft?'done':'later');keys.ArrowRight=()=>triage(subject,doneLeft?'later':'done');}
   if(t){keys.r=()=>void newDraft({},t,state?.settings.defaultReply);keys.R=()=>void newDraft({},t,state?.settings.defaultReply==='reply-all'?'reply':'reply-all');keys.f=()=>void newDraft({},t,'forward');}
   if(keys[e.key]){e.preventDefault();keys[e.key]();}
  }
  function keyup(e:KeyboardEvent){if(e.key!==' ')return;const hold=spaceHold.current;if(!hold)return;spaceHold.current=null;clearTimeout(hold.timer);if(hold.fired)talk('release');else if(selectedThread&&!composer)void newDraft({},selectedThread,state?.settings.defaultReply);}
  addEventListener('keydown',keyboard);addEventListener('keyup',keyup);return ()=>{removeEventListener('keydown',keyboard);removeEventListener('keyup',keyup);};
 });
 const bulkBar=usePresence(selected.size>0);
 const listShown=!popoutThread&&(!selectedThread||state?.settings.openMode==='split');
 const listKey=(searchMode?'search':route.view)+(route.view==='later'?laterTab:'');
 useEffect(()=>{if(route.threadId)setCursor({id:route.threadId,shown:true});},[route.threadId]);
 useEffect(()=>{setCursor(c=>({...c,shown:false}));selectAnchor.current=null;},[listKey]);
 useLayoutEffect(()=>{if(listRef.current)listRef.current.scrollTop=0;listScroll.current=0;},[listKey]);
 // In stack mode the list unmounts behind the reader; put it back where it was before scrolling to the cursor.
 useLayoutEffect(()=>{if(listShown&&listRef.current)listRef.current.scrollTop=listScroll.current;},[listShown]);
 useEffect(()=>{if(cursor.shown&&cursor.id&&listShown)document.querySelector(`.mail-row[data-thread-id="${CSS.escape(cursor.id)}"]`)?.scrollIntoView({block:'nearest',behavior:reducedMotion()?'auto':'smooth'});},[cursor,listShown]);

 if(!state)return <div className="loading-screen"><span className="app-icon ink large">a</span><h2>{fatal?'Aplos needs a moment.':'Making room for your mail…'}</h2>{fatal?<><p>{fatal}</p><Button variant="primary" onClick={()=>void refresh()}>Try again</Button><p className="small muted">For browser development, run npm run dev.</p></>:<Spinner size={20} className="muted"/>}</div>;

 const prefs=state.settings;
 const {low,later,homeLater,replyHome,today}=buckets;
 const pending=state.drafts.filter(d=>d.pendingSendAt);
 const drafts=state.drafts.filter(d=>!d.pendingSendAt&&(state.selectedAccountId==='all'||d.accountId===state.selectedAccountId));
 function count(view:View){if(view==='home')return scoped.filter(t=>t.status==='new').length+homeLater.length;if(view==='later')return later.length;if(view==='drafts')return drafts.length;if(view==='needs-reply'||view==='awaiting-reply')return scoped.filter(t=>t.replyStatus===view&&t.status!=='trash'&&t.status!=='spam').length;return 0;}
 const heading={title:searchMode?'Search':titles[route.view],count:filtered.length};
 const replySlot=inlineReply&&composer?<Compose key={composer.id} inline draft={composer} accounts={state.accounts} settings={prefs} thread={selectedThread} close={closeCompose} notify={notify} onChange={setLiveDraft} contacts={contacts} fresh={freshDraft.current===composer.id} holdToTalk={()=>talkHeld.current}/>:busy==='reply'&&!composer?<div className="compose-inline"><ComposeSkeleton/></div>:undefined;
 const readerProps={settings:prefs,editEvent:setEventEditor,notify,undo:()=>void undo(),talk,heading};
 const reader=selectedThread&&<Reader key={selectedThread.id} {...readerProps} thread={selectedThread} index={readerIndex} total={order.length} back={()=>{if(popoutThread)window.close();else if(!replyGuard())setRoute(r=>({...r,threadId:undefined}));}} patch={patch} triage={status=>triage(selectedThread,status)} reply={mode=>void newDraft({},selectedThread,mode)} standalone={!!popoutThread} replySlot={replySlot} entering={entering?.id===selectedThread.id?entering.from:undefined}/>;
 const ghost=leaving&&prefs.openMode==='stack'&&<div key={leaving.key} className={'fling fling-'+leaving.status} aria-hidden="true"><Reader ghost {...readerProps} thread={leaving.thread} index={0} total={1} back={noop} patch={async()=>{}} triage={noop} reply={noop}/></div>;
 const doneLeft=prefs.triageDirection==='done-left';
 const rows:RowHandlers={
  activeId:route.threadId,cursorId:cursor.shown?cursor.id:undefined,selected,doneLeft,
  highlight:searchMode?highlightTerms(search):undefined,
  open:t=>{if(searchMode)rememberSearch(search);openThread(t.id);},
  select:selectRow,
  triage,
  bookmark:t=>void patch([t.id],{bookmarked:!t.bookmarked},t.bookmarked?'Bookmark removed':'Bookmarked'),
  more:(t,anchor)=>{setMenuThread(t);rowMenu.openAt(anchor);},
  hover:(t,on)=>{if(on){hoveredId.current=t.id;if(cursor.id!==t.id||cursor.shown)setCursor({id:t.id,shown:false});}else if(hoveredId.current===t.id)hoveredId.current=null;},
 };
 const group=(title:string,threads:Thread[],action?:React.ReactNode,showCount=true)=><MailSection key={title} title={title} threads={threads} action={action} showCount={showCount} rows={rows}/>;
 const titled=(title:string,body:React.ReactNode)=><section className="mail-section"><header><h2>{title}</h2></header>{body}</section>;
 const emptyFor=(view:View)=>{const spec=searchMode?{icon:Search,title:'No matches yet',detail:'Try fewer words, or a sender’s name.'}:empties[view]??{title:'Nothing here'};return <EmptyState icon={spec.icon} title={spec.title} detail={spec.detail}/>;};

 if(popoutDraft)return <><div className="popout-titlebar"/>{composer?<Compose draft={composer} accounts={state.accounts} settings={prefs} thread={state.threads.find(t=>t.id===composer.threadId)} close={closeCompose} notify={notify} onChange={setLiveDraft} contacts={contacts} popout fresh={freshDraft.current===composer.id}/>:<div className="loading-screen"><h2>{draftBlocked?'This draft is open in another window.':'This draft is no longer available.'}</h2><Button onClick={()=>window.close()}>Close window</Button></div>}<Toaster/><ConfirmHost/></>;

 const syncing=busy==='sync'||state.sync.busy;
 const listView=!['settings','calendar'].includes(route.view);
 const swipe=<Button variant="pill" icon={Layers} shortcut="S" onClick={()=>{if(order[0])openThread(order[0].id);}}>One at a time</Button>;
 const composerLayer=!!composer&&!inlineReply;
 const sidebarHidden=!prefs.sidebar||!!popoutThread;
 const view=route.view;
 const thread=menuThread;

 let list:React.ReactNode;
 if(searchMode)list=search?filtered.length?group(`${filtered.length} result${filtered.length===1?'':'s'}`,filtered,undefined,false):!searching&&searchedFor===search&&emptyFor(view):<EmptyState compact icon={Search} title="Search your mail" detail="Senders, subjects and the words inside your messages."/>;
 else if(view==='home')list=<>{group('New',filtered,swipe)}{low.length>0&&<button className="low-bundle" onClick={()=>navigate('low')}><span className="low-count">{low.length}</span><span><strong>Low-importance emails</strong><small>{[...new Set(low.map(t=>t.messages[0].fromName))].join(', ')}</small></span></button>}{group('Ready when you are',homeLater,<Button variant="text" onClick={()=>{for(const t of homeLater)hintExit(t.id,'down');void invoke('home.hide',{ids:homeLater.map(t=>t.id)}).then(()=>notify(`Hid ${homeLater.length} from Home. They stay in Later.`)).catch(fail);}}>Hide all</Button>)}{group('Waiting on you',replyHome)}{!filtered.length&&!low.length&&!homeLater.length&&!replyHome.length&&emptyFor('home')}</>;
 else if(view==='drafts')list=titled('Drafts',drafts.length?<DraftList drafts={drafts} open={d=>void openDraft(d)} remove={async d=>{if(!await confirmAction({title:'Delete this draft?',message:'It will be removed from this device and from Gmail drafts.',confirmLabel:'Delete',danger:true}))return;hintExit(d.id,'down');void invoke('draft.delete',{id:d.id}).catch(fail);}}/>:emptyFor('drafts'));
 else if(view==='later'&&laterTab==='todos')list=<>{group('Overdue',filtered.filter(t=>t.dueDate&&t.dueDate<today))}{group('Todos without a specific date',filtered.filter(t=>!t.dueDate))}{group('Upcoming',filtered.filter(t=>t.dueDate&&t.dueDate>=today))}{!filtered.length&&emptyFor('later')}</>;
 else{const title=view==='later'?'Bookmarks':titles[view];list=filtered.length?group(title,filtered,view==='low'?<Button variant="pill" icon={CheckCheck} onClick={()=>{for(const t of filtered)hintExit(t.id,exitDirection('done'));void patch(filtered.map(t=>t.id),{status:'done'},'Low-importance mail marked done');}}>Mark all done</Button>:undefined,false):titled(title,view==='later'?<EmptyState icon={Bookmark} title="No bookmarks" detail="Press B on an email to keep it close."/>:emptyFor(view));}

 return <div className={cx('app-shell',window.aplos&&'desktop',mac&&'mac',sidebarHidden&&'sidebar-hidden',ask&&'with-ask')}>
 {!popoutThread&&<div className="sidebar-slot" inert={sidebarHidden||undefined}><Sidebar state={state} view={searchMode?null:route.view} count={count} zen={prefs.zen} online={online} syncing={syncing}
  canBack={historyIndex>0} canForward={historyIndex<routes.length-1} navigate={navigate} back={()=>historyMove(-1)} forward={()=>historyMove(1)} sync={()=>void sync()} hide={()=>void updateSettings({sidebar:false})}
  selectAccount={id=>{void invoke('account.select',{id}).catch(fail);if(id!=='all')setRoute({view:'home'});}} shortcuts={()=>setShortcutHelp(true)} onError={fail}/></div>}
 <main className="workspace">
 <Topbar showSidebarButton={!prefs.sidebar&&!popoutThread} showBack={!!selectedThread&&!popoutThread&&prefs.openMode==='stack'} showActions={!popoutThread} showModes={listView&&!composerLayer} showAsk={!ask}
  openMode={prefs.openMode} composeBusy={busy==='draft'||busy==='reply'} showSidebar={()=>void updateSettings({sidebar:true})} back={()=>{if(!replyGuard())setRoute(r=>({...r,threadId:undefined}));}}
  setOpenMode={openMode=>void updateSettings({openMode})} compose={()=>void newDraft()} ask={()=>setAsk(true)}/>
 {state.sync.error&&<div className="sync-error"><WifiOff size={14}/><span>{state.sync.error}</span><Button variant="text" size="sm" onClick={()=>void sync()}>Retry</Button></div>}
 <div className={cx('content-layout',selectedThread&&prefs.openMode==='split'&&'split-layout')}>
 {listShown&&<div className="mail-content" ref={listRef} onScroll={e=>{listScroll.current=e.currentTarget.scrollTop;}}>
 {view==='settings'?<Settings state={state} capabilities={capabilities} onChange={p=>void updateSettings(p)} notify={notify} shortcuts={()=>setShortcutHelp(true)}/>
 :view==='calendar'?<Calendar events={state.events} accounts={state.accounts} accountId={state.selectedAccountId} edit={setEventEditor} onThread={id=>navigate('all',id)}/>
 :<div className="mail-view" key={(searchMode?'search':view)+(view==='later'?laterTab:'')}>
  {searchMode&&<div className="search-heading"><div className="search-box"><Search size={17}/><input ref={searchInput} autoFocus placeholder="Search your mail" aria-label="Search mail query" value={search} onChange={e=>setSearch(e.target.value)} onKeyDown={searchKeys}/>{searching&&<Spinner size={16}/>}<IconButton label="Close search" shortcut="Esc" icon={X} onClick={closeSearch}/></div>
   {!search&&recentSearches.length>0&&<p className="search-hints"><span>Recent</span>{recentSearches.map(hint=><button key={hint} onClick={()=>{setSearch(hint);searchInput.current?.focus();}}>{hint}</button>)}</p>}
   {searchHints.length>0&&<p className="search-hints"><span>Try</span>{searchHints.map(hint=><button key={hint} className={search===hint?'is-active':undefined} onClick={()=>{setSearch(hint);searchInput.current?.focus();}}>{hint}</button>)}</p>}
   {search&&filtered.length>0&&<p className="search-hints search-keys"><Keys combo="↑"/><Keys combo="↓"/> to move, <Keys combo="↩"/> to open</p>}</div>}
  {view==='later'&&!searchMode&&<Tabs variant="underline" label="Later groups" className="later-tabs" value={laterTab} onChange={setLaterTab} items={[{id:'todos',label:'Todos',icon:CircleCheck,count:later.length},{id:'bookmarks',label:'Bookmarks',icon:Bookmark,count:scoped.filter(t=>t.bookmarked).length}]}/>}
  {bulkBar.mounted&&<div className={cx('bulk-toolbar',bulkBar.closing&&'is-closing')}><Checkbox checked={selected.size===order.length&&order.length>0} indeterminate={selected.size>0&&selected.size<order.length} label={`${selected.size||1} selected`} onChange={on=>setSelected(new Set(on?order.map(t=>t.id):[]))}/>
   <div className="actions"><Button variant="ghost" icon={Check} onClick={()=>bulk('done','Marked done')}>Done</Button><Button variant="ghost" icon={Clock} onClick={()=>bulk('later','Moved to Todo')}>Todo</Button><IconButton label="Move selected to Trash" icon={Trash2} onClick={()=>bulk('trash','Moved to Trash')}/><IconButton label="Clear selection" shortcut="Esc" icon={X} onClick={()=>setSelected(new Set())}/></div></div>}
  {list}
 </div>}
 </div>}
 {reader}
 {ghost}
 </div>
 {composerLayer&&composer&&<Compose key={composer.id} draft={composer} accounts={state.accounts} settings={prefs} thread={state.threads.find(t=>t.id===composer.threadId)} close={closeCompose} notify={notify} onChange={setLiveDraft} contacts={contacts} fresh={freshDraft.current===composer.id} closing={composeClosing} holdToTalk={()=>talkHeld.current}/>}
 {busy==='draft'&&!composer&&<div className="compose-layer"><ComposeSkeleton/></div>}
 <DuePopover prompt={duePrompt} setDue={(id,day,label)=>void setDue(id,day,label)} dismiss={()=>setDuePrompt(undefined)}/>
 </main>
 {!popoutThread&&<div className={cx('ask-dock',ask&&'open')} inert={!ask||undefined}><Ask open={ask} onClose={()=>setAsk(false)} onSearch={query=>{if(replyGuard())return;setSearch(query);setSearchMode(true);setRoute(r=>({...r,threadId:undefined}));}} conversations={state.conversations} threads={state.threads} accountId={state.selectedAccountId} settings={prefs} examples={askExamples} onThread={id=>navigate('all',id)} onDraft={d=>void newDraft(d)} notify={notify} currentDraft={liveDraft||composer} onApplyDraft={p=>{if(!composer)return;setComposer({...liveDraft||composer,...p,id:composer.id,accountId:composer.accountId,mode:composer.mode,threadId:composer.threadId,attachments:(liveDraft||composer).attachments,revision:(liveDraft||composer).revision,updatedAt:new Date().toISOString()});}}/></div>}
 <Menu open={rowMenu.open} anchor={rowMenu.anchor} onClose={rowMenu.close} placement="bottom-end" label="Email actions" onError={fail} groups={thread?[
  [{label:'Open in separate window',icon:ExternalLink,onSelect:()=>invoke('window.thread',{threadId:thread.id})}],
  [{label:'Mark '+(thread.unread?'read':'unread'),icon:MailOpen,keys:'U',onSelect:()=>patch([thread.id],{unread:!thread.unread})},
   {label:thread.importance==='important'?'Move to Low importance':'Mark important',icon:Layers,onSelect:()=>patch([thread.id],{importance:thread.importance==='important'?'low':'important'},thread.importance==='important'?'Moved to Low importance':'Marked important')},
   {label:thread.replyStatus==='needs-reply'?'Clear Needs reply':'Needs my reply',icon:CornerUpLeft,onSelect:()=>patch([thread.id],{replyStatus:thread.replyStatus==='needs-reply'?'none':'needs-reply'})}],
  [{label:'Move to Spam',icon:ShieldAlert,onSelect:()=>triage(thread,'spam')},{label:'Move to Trash',icon:Trash2,keys:'#',danger:true,onSelect:()=>triage(thread,'trash')}],
 ]:[]}/>
 {eventEditor&&<EventEditor key={eventEditor.id||eventEditor.title||'new'} event={eventEditor} accounts={state.accounts} onClose={()=>setEventEditor(null)} notify={notify}/>}
 <ShortcutsDialog open={shortcutHelp} close={()=>setShortcutHelp(false)} doneLeft={doneLeft}/>
 <WelcomeDialog open={!prefs.onboardingDone&&!popoutThread} icon={prefs.icon} busy={busy==='connect'} error={welcomeError} connect={async()=>{setBusy('connect');try{await invoke('account.connect');}catch(e){setWelcomeError((e as Error).message);}finally{setBusy('');}}} explore={()=>void updateSettings({onboardingDone:true})}/>
 <PendingSends drafts={pending} now={now} seconds={prefs.undoSeconds} undo={async d=>{try{await invoke('draft.undoSend',{id:d.id});notify('Send cancelled. Your draft is safe.');}catch(e){fail(e);}}}/>
 <Toaster/>
 <ConfirmHost/>
 </div>;
}
