import {useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {Bookmark,Check,CheckCheck,CircleCheck,Clock,CornerUpLeft,ExternalLink,FileText,Layers,MailOpen,MessageCircle,Search,Send,ShieldAlert,Trash2,WifiOff,X} from './icons';
import type {AppState,CalendarEvent,Capabilities,Draft,Settings as Preferences,Thread,View} from '../shared/types';
import {bridge,escapeHtml,invoke,isoDay,replyRecipients,uid} from './bridge';
import {createLiveState,threadOrder,type StateChanges,type ThreadPage} from '../shared/live';
import {Compose,addressOf,validAddress,type Contact} from './Compose';
import {Ask} from './Ask';
import {Reader,type CardDrag} from './Reader';
import {Calendar,EventEditor} from './Calendar';
import {Settings} from './Settings';
import {Sidebar,sections} from './components/Sidebar';
import {Topbar} from './components/Topbar';
import {DraftList,MailSection,highlightTerms,type RowActions,type RowHandlers,type Triage} from './components/MailList';
import {ComposeSkeleton,DuePopover,PendingSends,ShortcutsDialog,WelcomeDialog} from './components/Overlays';
import {AddAccountDialog} from './components/AddAccount';
import {Button,Checkbox,ConfirmHost,EmptyState,IconButton,Keys,Menu,Spinner,Tabs,Toaster,confirmAction,cx,dialogOpen,hintExit,reducedMotion,toast,useHandlers,useMenu,usePresence,type Icon} from './ui';

const titles:Record<View,string>={home:'Home',later:'Later',all:'All mail',drafts:'Drafts',sent:'Sent','needs-reply':'Needs reply','awaiting-reply':'Awaiting reply',trash:'Trash',spam:'Spam',low:'Low importance',calendar:'Calendar',settings:'Settings'};
const empties:Partial<Record<View,{icon:Icon;title:string;detail?:string}>>={
  home:{icon:CircleCheck,title:'All clear for now',detail:'New mail that matters will land here.'},
  later:{icon:Clock,title:'Nothing saved for later',detail:'Press L on an email to keep it as a Todo.'},
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
function useMediaQuery(query:string){
 const [matches,setMatches]=useState(()=>matchMedia(query).matches);
 useEffect(()=>{const media=matchMedia(query);const update=()=>setMatches(media.matches);update();media.addEventListener('change',update);return ()=>media.removeEventListener('change',update);},[query]);
 return matches;
}

export function App(){
 const [state,setState]=useState<AppState>();
 const [capabilities,setCapabilities]=useState<Capabilities>({groq:false,google:false,microsoft:false,desktop:!!window.aplos,version:'0.1.0'});
 const [fatal,setFatal]=useState('');
 const [route,setRoute]=useState<Route>({view:'home',threadId:popoutThread??undefined});
 const [routes,setRoutes]=useState<Route[]>([{view:'home'}]);const [historyIndex,setHistoryIndex]=useState(0);
 const [ask,setAsk]=useState(()=>!popoutThread&&localStorage.getItem(askStorageKey)!=='closed');
 // Matches the CSS breakpoints that collapse the sidebar; while squeezed it opens as an overlay instead.
 const squeezed=useMediaQuery(ask?'(max-width: 900px)':'(max-width: 700px)');const [peek,setPeek]=useState(false);
 useEffect(()=>{if(!squeezed)setPeek(false);},[squeezed]);
 useEffect(()=>{if(peek)requestAnimationFrame(()=>document.querySelector<HTMLElement>('.sidebar-slot .nav-item.active, .sidebar-slot .nav-item')?.focus());},[peek]);
 // The draft as typed lives in a ref: keeping it in state re-rendered the whole app on every keystroke.
 const [composer,setComposer]=useState<Draft>();const liveDraft=useRef<Draft|undefined>(undefined);const setLiveDraft=useCallback((draft?:Draft)=>{liveDraft.current=draft;},[]);const [composeClosing,setComposeClosing]=useState(false);const [draftBlocked,setDraftBlocked]=useState(false);
 const [laterTab,setLaterTab]=useState<'todos'|'bookmarks'>('todos');
 const [selected,setSelected]=useState<Set<string>>(new Set());
 const [search,setSearch]=useState('');const [searchMode,setSearchMode]=useState(false);const [searchResults,setSearchResults]=useState<Thread[]>([]);const [searching,setSearching]=useState(false);const [searchedFor,setSearchedFor]=useState('');
 const [shortcutHelp,setShortcutHelp]=useState(false);
 const [eventEditor,setEventEditor]=useState<Partial<CalendarEvent>|null>(null);
 const [online,setOnline]=useState(navigator.onLine);
 const [busy,setBusy]=useState('');const [welcomeAdding,setWelcomeAdding]=useState(false);
 const [leaving,setLeaving]=useState<{thread:Thread;status:Triage;key:number;to:string;drag?:CardDrag}>();
 const [entering,setEntering]=useState<{id:string;from:string}>();
 const [duePrompt,setDuePrompt]=useState<{id:string;key:number}>();
 const rowMenu=useMenu();const [menuThread,setMenuThread]=useState<Thread>();
 // Hover is tracked in refs so pointing at rows does not re-render the app; `lastHovered` is where J/K continue from.
 const freshDraft=useRef('');const hoveredId=useRef<string|null>(null);const lastHovered=useRef<string|null>(null);const talkHeld=useRef(false);
 const spaceHold=useRef<{timer?:ReturnType<typeof setTimeout>;fired:boolean}|null>(null);
 const lastTriage=useRef<{id:string;status:Triage;reopen:boolean}|null>(null);
 const searchInput=useRef<HTMLInputElement>(null);const eventHandler=useRef<(event:{type:string;payload?:unknown})=>void>(()=>{});
 const searchSeq=useRef(0);const composeRef=useRef<Draft|undefined>(undefined);composeRef.current=composer;
 const undoRef=useRef<()=>void>(noop);
 // `shown` is false while the pointer drives the list, so the hover highlight is the only cue.
 const [cursor,setCursor]=useState<{id?:string;shown:boolean}>({shown:false});
 const [recentSearches,setRecentSearches]=useState<string[]>(()=>{try{const saved=JSON.parse(localStorage.getItem(recentSearchKey)||'[]');return Array.isArray(saved)?saved.filter(q=>typeof q==='string').slice(0,5):[];}catch{return [];}});
 const selectAnchor=useRef<string|null>(null);const listRef=useRef<HTMLDivElement>(null);const listScroll=useRef(0);
 const workspaceRef=useRef<HTMLElement>(null);const workspaceLeft=useRef<number|null>(null);const workspaceSlide=useRef<Animation|undefined>(undefined);

 function notify(text:string,undoable=false){toast.show({text,action:undoable?{label:'Undo',shortcut:'Z',run:()=>undoRef.current()}:undefined});}
 function fail(error:unknown){toast.show({text:error instanceof Error?error.message:String(error),tone:'error'});}
 // The window keeps its own copy of the mailbox: the newest threads first, older ones in pages, then changes as they happen.
 const loadSeq=useRef(0);const refreshRef=useRef<(rethrow?:boolean)=>Promise<void>>(async()=>{});
 // A resync rethrows so the live copy retries with backoff instead of staying behind.
 const live=useMemo(()=>createLiveState({update:setState,resync:()=>refreshRef.current(true)}),[]);
 const refresh=useCallback(async(rethrow=false)=>{
  const seq=++loadSeq.current;
  try{
   const first=await invoke<AppState>('state.get',popoutDraft||popoutThread?{}:{threadLimit:400});if(seq!==loadSeq.current)return;
   live.snapshot(first);setFatal('');
   let next:{date:string;id:string}|undefined=first.threadCount&&first.threads.length<first.threadCount?[...first.threads].sort(threadOrder).at(-1):undefined;
   while(next&&seq===loadSeq.current){
    const page=await invoke<ThreadPage>('threads.page',{before:{date:next.date,id:next.id},limit:2000});
    if(seq!==loadSeq.current||!live.page(page))break;
    next=page.next;
   }
  }catch(e){if(seq===loadSeq.current)setFatal((e as Error).message);if(rethrow)throw e;}
 },[live]);
 refreshRef.current=refresh;
 useEffect(()=>{
  void refresh();void invoke<Capabilities>('capabilities.get').then(setCapabilities).catch(()=>{});
  const unsubscribe=bridge.subscribe(e=>eventHandler.current(e));
  const up=()=>setOnline(true);const down=()=>setOnline(false);addEventListener('online',up);addEventListener('offline',down);
  return ()=>{unsubscribe();removeEventListener('online',up);removeEventListener('offline',down);};
 },[]);
 useEffect(()=>{if(!popoutThread)localStorage.setItem(askStorageKey,ask?'open':'closed');},[ask]);
 // The service paces automatic syncs per account, so focusing often is cheap.
 useEffect(()=>{const onFocus=()=>{void invoke('sync',{auto:true}).catch(()=>{});};window.addEventListener('focus',onFocus);return()=>window.removeEventListener('focus',onFocus);},[]);
 useEffect(()=>{if(!leaving)return;const t=setTimeout(()=>setLeaving(undefined),340);return ()=>clearTimeout(t);},[leaving?.key]);
 useEffect(()=>{if(!duePrompt)return;const t=setTimeout(()=>setDuePrompt(undefined),7000);return ()=>clearTimeout(t);},[duePrompt?.key]);
 useEffect(()=>{if(!state)return;const theme=state.settings.theme;const media=matchMedia('(prefers-color-scheme: dark)');const apply=()=>document.documentElement.dataset.theme=theme==='system'?(media.matches?'dark':'light'):theme;apply();media.addEventListener('change',apply);return ()=>media.removeEventListener('change',apply);},[state?.settings.theme]);
 useEffect(()=>{if(!popoutDraft||!state||composer||draftBlocked)return;const draft=state.drafts.find(d=>d.id===popoutDraft);if(draft)void invoke<boolean>('window.claim',{draftId:draft.id}).then(ok=>ok?setComposer(draft):setDraftBlocked(true)).catch(e=>setFatal(e.message));},[!!state,popoutDraft]);

 function replyGuard(){if(!inlineReply)return false;notify('Send or close your reply first.');return true;}
 function navigate(view:View,threadId?:string){if(replyGuard())return;const next={view,threadId};setRoute(next);setSearchMode(false);setSelected(new Set());setRoutes(prev=>[...prev.slice(0,historyIndex+1),next]);setHistoryIndex(i=>i+1);}
 function historyMove(delta:number){if(replyGuard())return;const index=historyIndex+delta;if(index<0||index>=routes.length)return;setHistoryIndex(index);setRoute(routes[index]);setSelected(new Set());setSearchMode(false);}
 async function updateSettings(patch:Partial<Preferences>){try{await invoke('settings.update',{patch});}catch(e){fail(e);}}
 async function patch(ids:string[],p:Partial<Thread>,label?:string,keepTriage=false){if(!keepTriage)lastTriage.current=null;try{await invoke('thread.update',{ids,patch:p,compact:true});if(label)notify(label,true);setSelected(new Set());}catch(e){fail(e);}}
 async function undo(){
  const last=lastTriage.current;lastTriage.current=null;setDuePrompt(undefined);toast.dismissActions();
  try{await invoke('thread.undo',{compact:true});
   if(last?.reopen&&!inlineReply){setLeaving(undefined);if(!reducedMotion())setEntering({id:last.id,from:last.status==='done'?'right':last.status==='later'?'left':'below'});setRoute(r=>({...r,threadId:last.id}));}
   else notify('Action undone');
  }catch(e){if(/nothing to undo/i.test((e as Error).message))notify('Nothing to undo');else fail(e);}
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
  const d:Draft={id:uid(),accountId:a.id,to,cc,bcc:'',subject,html,attachments:[],mode,signature:true,...(a.provider!=='demo'?{fromEmail:alias?.email||a.email,signatureSource:alias&&a.capabilities?.signatures!==false?'account' as const:'custom' as const}:{}),updatedAt:new Date().toISOString(),revision:0,...(thread&&mode!=='forward'?{threadId:thread.id}:{}),...proposal};
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
  const today=isoDay();const later=scoped.filter(t=>t.status==='later');
  return {today,later,low:scoped.filter(t=>t.status==='new'&&t.importance==='low'),
   homeLater:later.filter(t=>!t.hiddenFromHome&&(!t.dueDate||t.dueDate<=today)),
   replyHome:scoped.filter(t=>t.replyStatus==='needs-reply'&&t.status==='done'&&!t.hiddenFromHome)};
 },[scoped]);
 const todoGroups=useMemo(()=>{
  const today=buckets.today;const dated=filtered.filter(t=>t.dueDate).sort((a,b)=>a.dueDate!.localeCompare(b.dueDate!));
  return {overdue:dated.filter(t=>t.dueDate!<today),today:dated.filter(t=>t.dueDate!.slice(0,10)===today),upcoming:dated.filter(t=>t.dueDate!.slice(0,10)>today),undated:filtered.filter(t=>!t.dueDate)};
 },[filtered,buckets.today]);
 // The order rows appear on screen, so j/k, ⇧-click ranges and the reader stack all walk the same sequence.
 const order=useMemo(()=>{
  if(searchMode)return filtered;
  if(route.view==='home')return [...filtered,...buckets.homeLater,...buckets.replyHome];
  if(route.view==='later'&&laterTab==='todos')return [...todoGroups.overdue,...todoGroups.today,...todoGroups.upcoming,...todoGroups.undated];
  return filtered;
 },[filtered,buckets,todoGroups,route.view,laterTab,searchMode]);
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
 function openThread(id:string){if(inlineReply&&id!==selectedThread?.id){notify('Send or close your reply first.');return;}setRoute(r=>({...r,threadId:id}));const t=state?.threads.find(t=>t.id===id);if(t?.unread)void invoke('thread.update',{ids:[id],patch:{unread:false},recordUndo:false,compact:true}).catch(fail);}
 function nextThread(delta:number){const next=order[readerIndex+delta];if(next)openThread(next.id);}
 function moveCursor(delta:number){
  if(!order.length)return;const from=cursor.shown?cursor.id:lastHovered.current??cursor.id;const at=order.findIndex(t=>t.id===from);
  const index=at<0?(delta>0?0:order.length-1):cursor.shown||hoveredId.current?Math.min(order.length-1,Math.max(0,at+delta)):at;
  lastHovered.current=null;setCursor({id:order[index].id,shown:true});
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
 function triage(thread:Thread,status:Triage,drag?:CardDrag){
  const current=thread.id===selectedThread?.id;const stack=state?.settings.openMode==='stack';
  hintExit(thread.id,exitDirection(status));
  // The stack dock has its own undo button, so the toast would only cover it.
  void patch([thread.id],{status},current&&stack?undefined:triageLabels[status],true);
  lastTriage.current={id:thread.id,status,reopen:current};
  setDuePrompt(status==='later'?{id:thread.id,key:Date.now()}:undefined);setEntering(undefined);
  // Right after an undo the reopened thread may not be back in the list yet, so fall back to its date position.
  const at=order.findIndex(t=>t.id===thread.id);
  const following=at>=0?order[at+1]||order[at-1]:order.find(t=>t.date<=thread.date)||order.at(-1);
  if(lastHovered.current===thread.id)lastHovered.current=following?.id??null;
  if(!current){if(cursor.id===thread.id)setCursor(c=>({...c,id:following?.id}));return;}
  if(stack&&!reducedMotion())setLeaving({thread,status,key:Date.now(),to:exitDirection(status),drag});
  if(following&&following.id!==thread.id)setRoute(r=>({...r,threadId:following.id}));else setRoute(r=>({...r,threadId:undefined}));
  if(following?.unread)void invoke('thread.update',{ids:[following.id],patch:{unread:false},recordUndo:false,compact:true}).catch(()=>{});
 }
 function bulk(status:Triage,label:string){const ids=[...selected];for(const id of ids)hintExit(id,exitDirection(status));if(cursor.id&&selected.has(cursor.id)){const at=order.findIndex(t=>t.id===cursor.id);setCursor(c=>({...c,id:order.slice(at+1).find(t=>!selected.has(t.id))?.id}));}void patch(ids,{status},`${label} · ${ids.length} email${ids.length===1?'':'s'}`);}
 function talk(phase:'start'|'release'){
  if(phase==='start'){
   if(talkHeld.current||!selectedThread)return;talkHeld.current=true;
   const release=()=>{removeEventListener('pointerup',release);talk('release');};addEventListener('pointerup',release);
   void newDraft({},selectedThread,state?.settings.defaultReply);
  }else if(talkHeld.current){talkHeld.current=false;dispatchEvent(new Event('aplos:talk-release'));}
 }
 async function setDue(id:string,dueDate:string,label:string){setDuePrompt(undefined);try{await invoke('thread.update',{ids:[id],patch:{dueDate},recordUndo:false,compact:true});notify(label);}catch(e){fail(e);}}
 function openSearch(){if(replyGuard())return;setSearchMode(true);setRoute(r=>({...r,threadId:undefined}));setTimeout(()=>searchInput.current?.focus(),20);}
 function closeSearch(){setSearchMode(false);setSearch('');}
 function rememberSearch(query:string){const value=query.trim();if(!value)return;setRecentSearches(prev=>{const next=[value,...prev.filter(q=>q!==value)].slice(0,5);localStorage.setItem(recentSearchKey,JSON.stringify(next));return next;});}
 function searchKeys(e:React.KeyboardEvent<HTMLInputElement>){
  if(e.key==='Escape'){e.preventDefault();e.stopPropagation();if(search)setSearch('');else closeSearch();}
  else if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();moveCursor(e.key==='ArrowDown'?1:-1);}
  else if(e.key==='Enter'&&!e.nativeEvent.isComposing){const target=order.find(t=>t.id===cursor.id&&cursor.shown)||order[0];if(target){e.preventDefault();rememberSearch(search);openThread(target.id);}}
 }
 function command(command:string){if(command.startsWith('thread:')){navigate('all',command.slice(7));return;}switch(command){case'compose':void newDraft();break;case'settings':navigate('settings');break;case'search':openSearch();break;case'ask':setAsk(v=>!v);break;case'shortcuts':setShortcutHelp(true);break;case'toggle-sidebar':if(squeezed)setPeek(v=>!v);else void updateSettings({sidebar:!state?.settings.sidebar});break;case'back':historyMove(-1);break;case'forward':historyMove(1);break;case'refresh':void sync();break;case'undo':void undo();break;default:if(sections.some(s=>s.view===command))navigate(command as View);}}
 eventHandler.current=event=>{
  if(event.type==='state')live.snapshot(event.payload as AppState);
  else if(event.type==='changes')live.apply(event.payload as StateChanges);
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
   if(e.key==='Escape'&&squeezed&&peek){e.preventDefault();setPeek(false);return;}
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
 useEffect(()=>{if(route.threadId){lastHovered.current=null;setCursor({id:route.threadId,shown:true});}},[route.threadId]);
 useEffect(()=>{setCursor(c=>({...c,shown:false}));selectAnchor.current=null;lastHovered.current=null;},[listKey]);
 // Writing scrollTop forces a synchronous layout of the new view, so skip it when the list is already at the top.
 useLayoutEffect(()=>{if(listRef.current&&listScroll.current)listRef.current.scrollTop=0;listScroll.current=0;},[listKey]);
 // In stack mode the list unmounts behind the reader; put it back where it was before scrolling to the cursor.
 useLayoutEffect(()=>{if(listShown&&listRef.current)listRef.current.scrollTop=listScroll.current;},[listShown]);
 // When the sidebar shows or hides, the workspace jumps to its new place once and then slides there from the
 // old one with a transform, in step with the sidebar's own CSS slide.
 useLayoutEffect(()=>{
  const el=workspaceRef.current;if(!el)return;
  const left=el.offsetLeft,prev=workspaceLeft.current;workspaceLeft.current=left;
  if(prev===null||prev===left||reducedMotion())return;
  workspaceSlide.current?.cancel();
  workspaceSlide.current=el.animate([{transform:`translateX(${prev-left}px)`},{transform:'none'}],{duration:200,easing:'cubic-bezier(.16,1,.3,1)'});
 },[!!state,squeezed,peek,state?.settings.sidebar]);
 useEffect(()=>{if(cursor.shown&&cursor.id&&listShown)document.querySelector(`.mail-row[data-thread-id="${CSS.escape(cursor.id)}"]`)?.scrollIntoView({block:'nearest',behavior:reducedMotion()?'auto':'smooth'});},[cursor,listShown]);

 // Derived data and stable handlers for the memoized panes. Cursor moves, hovers and typing then re-render
 // only what changed instead of the sidebar, Ask and every row.
 const highlight=useMemo(()=>searchMode?highlightTerms(search):undefined,[searchMode,search]);
 const drafts=useMemo(()=>state?.drafts.filter(d=>!d.pendingSendAt&&(state.selectedAccountId==='all'||d.accountId===state.selectedAccountId))??[],[state?.drafts,state?.selectedAccountId]);
 const pending=useMemo(()=>state?.drafts.filter(d=>d.pendingSendAt)??[],[state?.drafts]);
 const counts=useMemo(()=>{
  const replies=(view:View)=>scoped.filter(t=>t.replyStatus===view&&t.status!=='trash'&&t.status!=='spam').length;
  return {home:scoped.filter(t=>t.status==='new').length+buckets.homeLater.length,later:buckets.later.length,drafts:drafts.length,'needs-reply':replies('needs-reply'),'awaiting-reply':replies('awaiting-reply')} as Partial<Record<View,number>>;
 },[scoped,buckets,drafts]);
 const rowActions=useHandlers<RowActions>({
  open:t=>{if(searchMode)rememberSearch(search);openThread(t.id);},
  select:(t,how)=>selectRow(t,how),
  triage:(t,status)=>triage(t,status),
  bookmark:t=>void patch([t.id],{bookmarked:!t.bookmarked},t.bookmarked?'Bookmark removed':'Bookmarked'),
  restore:t=>{hintExit(t.id,'down');void patch([t.id],{status:'new'},'Restored to Home');},
  more:(t,anchor)=>{setMenuThread(t);rowMenu.openAt(anchor);},
  hover:(t,on)=>{if(on){hoveredId.current=t.id;lastHovered.current=t.id;if(cursor.shown)setCursor({id:t.id,shown:false});}else if(hoveredId.current===t.id)hoveredId.current=null;},
 });
 const sidebarActions=useHandlers({
  navigate:(view:View)=>{setPeek(false);navigate(view);},back:()=>historyMove(-1),forward:()=>historyMove(1),sync:()=>void sync(),
  hide:()=>{if(squeezed)setPeek(false);else void updateSettings({sidebar:false});},
  selectAccount:(id:string)=>{void invoke('account.select',{id}).catch(fail);if(id!=='all')setRoute({view:'home'});},
  shortcuts:()=>{setPeek(false);setShortcutHelp(true);},onError:(error:Error)=>fail(error),
 });
 const topbarActions=useHandlers({
  showSidebar:()=>{if(squeezed)setPeek(true);else void updateSettings({sidebar:true});},
  back:()=>{if(!replyGuard())setRoute(r=>({...r,threadId:undefined}));},
  setOpenMode:(openMode:Preferences['openMode'])=>void updateSettings({openMode}),
  compose:()=>void newDraft(),ask:()=>setAsk(true),
 });
 const askActions=useHandlers({
  onClose:()=>setAsk(false),
  onSearch:(query:string)=>{if(replyGuard())return;setSearch(query);setSearchMode(true);setRoute(r=>({...r,threadId:undefined}));},
  onThread:(id:string)=>navigate('all',id),onDraft:(draft:Partial<Draft>)=>void newDraft(draft),notify:(text:string)=>notify(text),
  currentDraft:()=>liveDraft.current||composer,
  onApplyDraft:(p:Partial<Draft>)=>{if(!composer)return;const base=liveDraft.current||composer;setComposer({...base,...p,id:composer.id,accountId:composer.accountId,mode:composer.mode,threadId:composer.threadId,attachments:base.attachments,revision:base.revision,updatedAt:new Date().toISOString()});},
 });

 if(!state)return <div className="loading-screen"><span className="app-icon ink large">a</span><h2>{fatal?'Aplos needs a moment.':'Making room for your mail…'}</h2>{fatal?<><p>{fatal}</p><Button variant="primary" onClick={()=>void refresh()}>Try again</Button><p className="small muted">For browser development, run npm run dev.</p></>:<Spinner size={20} className="muted"/>}</div>;

 const prefs=state.settings;
 const {low,later,homeLater,replyHome,today}=buckets;
 const heading={title:searchMode?'Search':titles[route.view],count:filtered.length};
 const replySlot=inlineReply&&composer?<Compose key={composer.id} inline draft={composer} accounts={state.accounts} settings={prefs} thread={selectedThread} close={closeCompose} notify={notify} onChange={setLiveDraft} contacts={contacts} fresh={freshDraft.current===composer.id} holdToTalk={()=>talkHeld.current}/>:busy==='reply'&&!composer?<div className="compose-inline"><ComposeSkeleton/></div>:undefined;
 const readerProps={settings:prefs,editEvent:setEventEditor,notify,undo:()=>void undo(),talk,heading};
 const reader=selectedThread&&<Reader key={selectedThread.id} {...readerProps} thread={selectedThread} index={readerIndex} total={order.length} back={()=>{if(popoutThread)window.close();else if(!replyGuard())setRoute(r=>({...r,threadId:undefined}));}} patch={patch} triage={(status,drag)=>triage(selectedThread,status,drag)} reply={mode=>void newDraft({},selectedThread,mode)} standalone={!!popoutThread} replySlot={replySlot} entering={entering?.id===selectedThread.id?entering.from:undefined}/>;
 const ghost=leaving&&prefs.openMode==='stack'&&<div key={leaving.key} className={cx('fling','fling-'+leaving.status,'fling-to-'+leaving.to,leaving.drag&&'is-dragged')} style={leaving.drag&&{'--from-x':leaving.drag.x+'px','--from-r':(leaving.drag.x/leaving.drag.width*6).toFixed(2)+'deg'} as React.CSSProperties} aria-hidden="true"><Reader ghost {...readerProps} thread={leaving.thread} index={0} total={1} back={noop} patch={async()=>{}} triage={noop} reply={noop}/></div>;
 const doneLeft=prefs.triageDirection==='done-left';
 const rows:RowHandlers={activeId:route.threadId,cursorId:cursor.shown?cursor.id:undefined,selected,doneLeft,highlight,swipe:prefs.swipe,actions:rowActions};
 const group=(title:string,threads:Thread[],action?:React.ReactNode,showCount=true)=><MailSection key={title} title={title} threads={threads} action={action} showCount={showCount} rows={rows}/>;
 const titled=(title:string,body:React.ReactNode)=><section className="mail-section"><header><h2>{title}</h2></header>{body}</section>;
 const emptyFor=(view:View)=>{const spec=searchMode?{icon:Search,title:'No matches yet',detail:'Try fewer words, or a sender’s name.'}:empties[view]??{title:'Nothing here'};return <EmptyState icon={spec.icon} title={spec.title} detail={spec.detail}/>;};

 if(popoutDraft)return <><div className="popout-titlebar"/>{composer?<Compose draft={composer} accounts={state.accounts} settings={prefs} thread={state.threads.find(t=>t.id===composer.threadId)} close={closeCompose} notify={notify} onChange={setLiveDraft} contacts={contacts} popout fresh={freshDraft.current===composer.id}/>:<div className="loading-screen"><h2>{draftBlocked?'This draft is open in another window.':'This draft is no longer available.'}</h2><Button onClick={()=>window.close()}>Close window</Button></div>}<Toaster/><ConfirmHost/></>;

 const syncing=busy==='sync'||state.sync.busy;
 const listView=!['settings','calendar'].includes(route.view);
 const swipe=<Button variant="pill" icon={Layers} shortcut="S" onClick={()=>{if(order[0])openThread(order[0].id);}}>One at a time</Button>;
 const composerLayer=!!composer&&!inlineReply;
 const sidebarHidden=!!popoutThread||(squeezed?!peek:!prefs.sidebar);const peeking=squeezed&&peek&&!popoutThread;
 const view=route.view;
 const thread=menuThread;

 let list:React.ReactNode;
 if(searchMode)list=search?filtered.length?group(`${filtered.length} result${filtered.length===1?'':'s'}`,filtered,undefined,false):!searching&&searchedFor===search&&emptyFor(view):<EmptyState compact icon={Search} title="Search your mail" detail="Senders, subjects and the words inside your messages."/>;
 else if(view==='home')list=<>{group('New',filtered,swipe)}{low.length>0&&<button className="low-bundle" onClick={()=>navigate('low')}><span className="low-count">{low.length}</span><span><strong>Low-importance emails</strong><small>{[...new Set(low.map(t=>t.messages[0].fromName))].join(', ')}</small></span></button>}{group('Ready when you are',homeLater,<Button variant="text" onClick={()=>{for(const t of homeLater)hintExit(t.id,'down');void invoke('home.hide',{ids:homeLater.map(t=>t.id),compact:true}).then(()=>notify(`Hid ${homeLater.length} from Home. They stay in Later.`)).catch(fail);}}>Hide all</Button>)}{group('Waiting on you',replyHome)}{!filtered.length&&!low.length&&!homeLater.length&&!replyHome.length&&emptyFor('home')}</>;
 else if(view==='drafts')list=titled('Drafts',drafts.length?<DraftList drafts={drafts} open={d=>void openDraft(d)} remove={async d=>{if(!await confirmAction({title:'Delete this draft?',message:'It will be removed from this device and from your account’s drafts.',confirmLabel:'Delete',danger:true}))return;hintExit(d.id,'down');void invoke('draft.delete',{id:d.id}).catch(fail);}}/>:emptyFor('drafts'));
 else if(view==='later'&&laterTab==='todos')list=<>{group('Overdue',todoGroups.overdue)}{group('Today',todoGroups.today)}{group('Upcoming',todoGroups.upcoming)}{group('No due date',todoGroups.undated)}{!filtered.length&&emptyFor('later')}</>;
 else{const title=view==='later'?'Bookmarks':titles[view];list=filtered.length?group(title,filtered,view==='low'?<Button variant="pill" icon={CheckCheck} onClick={()=>{for(const t of filtered)hintExit(t.id,exitDirection('done'));void patch(filtered.map(t=>t.id),{status:'done'},'Low-importance mail marked done');}}>Mark all done</Button>:undefined,false):titled(title,view==='later'?<EmptyState icon={Bookmark} title="No bookmarks" detail="Press B on an email to keep it close."/>:emptyFor(view));}

 return <div className={cx('app-shell',window.aplos&&'desktop',mac&&'mac',sidebarHidden&&'sidebar-hidden',peeking&&'sidebar-peek',ask&&'with-ask')}>
 {peeking&&<div className="sidebar-scrim" onPointerDown={()=>setPeek(false)}/>}
 {!popoutThread&&<div className="sidebar-slot" inert={sidebarHidden||undefined} onKeyDown={e=>{if(peeking&&e.key==='Escape'){e.stopPropagation();setPeek(false);}}}><Sidebar state={state} view={searchMode?null:route.view} counts={counts} zen={prefs.zen} online={online} syncing={syncing}
  canBack={historyIndex>0} canForward={historyIndex<routes.length-1} {...sidebarActions}/></div>}
 <main className="workspace" ref={workspaceRef}>
 <Topbar showSidebarButton={sidebarHidden&&!popoutThread} showBack={!!selectedThread&&!popoutThread&&prefs.openMode==='stack'} showActions={!popoutThread} showModes={listView&&!composerLayer} showAsk={!ask}
  openMode={prefs.openMode} composeBusy={busy==='draft'||busy==='reply'} {...topbarActions}/>
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
  {bulkBar.mounted&&<div className={cx('bulk-toolbar ui-surface',bulkBar.closing&&'is-closing')}><Checkbox checked={selected.size===order.length&&order.length>0} indeterminate={selected.size>0&&selected.size<order.length} label={`${selected.size||1} selected`} onChange={on=>setSelected(new Set(on?order.map(t=>t.id):[]))}/>
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
 {!popoutThread&&<div className={cx('ask-dock',ask&&'open')} inert={!ask||undefined}><Ask open={ask} conversations={state.conversations} threads={state.threads} accountId={state.selectedAccountId} settings={prefs} examples={askExamples} hasDraft={!!composer} {...askActions}/></div>}
 <Menu open={rowMenu.open} anchor={rowMenu.anchor} onClose={rowMenu.close} placement="bottom-end" label="Email actions" onError={fail} groups={thread?[
  [{label:'Open in separate window',icon:ExternalLink,onSelect:()=>invoke('window.thread',{threadId:thread.id})}],
  [{label:'Mark '+(thread.unread?'read':'unread'),icon:MailOpen,keys:'U',onSelect:()=>patch([thread.id],{unread:!thread.unread})},
   {label:thread.importance==='important'?'Move to Low importance':'Mark important',icon:Layers,onSelect:()=>patch([thread.id],{importance:thread.importance==='important'?'low':'important'},thread.importance==='important'?'Moved to Low importance':'Marked important')},
   {label:thread.replyStatus==='needs-reply'?'Clear Needs reply':'Needs my reply',icon:CornerUpLeft,onSelect:()=>patch([thread.id],{replyStatus:thread.replyStatus==='needs-reply'?'none':'needs-reply'})}],
  [{label:'Move to Spam',icon:ShieldAlert,onSelect:()=>triage(thread,'spam')},{label:'Move to Trash',icon:Trash2,keys:'#',danger:true,onSelect:()=>triage(thread,'trash')}],
 ]:[]}/>
 {eventEditor&&<EventEditor key={eventEditor.id||eventEditor.title||'new'} event={eventEditor} accounts={state.accounts} onClose={()=>setEventEditor(null)} notify={notify}/>}
 <ShortcutsDialog open={shortcutHelp} close={()=>setShortcutHelp(false)} doneLeft={doneLeft}/>
 <WelcomeDialog open={!prefs.onboardingDone&&!popoutThread&&!welcomeAdding} icon={prefs.icon} connect={()=>setWelcomeAdding(true)} explore={()=>void updateSettings({onboardingDone:true})}/>
 <AddAccountDialog open={welcomeAdding} close={()=>setWelcomeAdding(false)} capabilities={capabilities} connected={()=>notify('Account connected')}/>
 <PendingSends drafts={pending} seconds={prefs.undoSeconds} undo={async d=>{try{await invoke('draft.undoSend',{id:d.id});notify('Send cancelled. Your draft is safe.');}catch(e){fail(e);}}}/>
 <Toaster/>
 <ConfirmHost/>
 </div>;
}
