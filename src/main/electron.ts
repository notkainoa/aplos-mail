import {app,BrowserWindow,dialog,ipcMain,Menu,Notification,safeStorage,shell,systemPreferences,nativeTheme,session,type IpcMainInvokeEvent,type MenuItemConstructorOptions} from 'electron';
import {config} from 'dotenv';
import {writeFile,mkdtemp} from 'node:fs/promises';
import {join,basename,extname,resolve} from 'node:path';
import {homedir,tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {createService} from './service';
import {DraftOwnership,draftMutationId} from './desktop-policy';
import type {AppState,Listener} from '../shared/types';

const methods=new Set([
  'state.get','capabilities.get','symbols.render','settings.update','account.select','account.connect','account.discover','domain.check','account.disconnect','sync','demo.reset',
  'thread.update','thread.undo','home.hide','search','draft.save','draft.delete','draft.send','draft.undoSend',
  'ai.summarize','ai.polish','ai.draft','ai.ask','ai.cancel','ai.transcribe','conversation.delete',
  'calendar.list','calendar.extract','calendar.save','calendar.delete','attachment.get','sender.block','sender.unblock','thread.unsubscribe','data.export',
]);
const nativeMethods=new Set(['window.compose','window.thread','window.claim','window.release','window.closeReady','window.closeCancel','shell.open','file.save','file.open','notification.test','system.login','system.defaultMail','system.microphone','app.info']);
const rendererFile=resolve(__dirname,'../renderer/index.html');
const rendererURL=pathToFileURL(rendererFile);
const devURL=process.env.APLOS_RENDERER_URL;
const windows=new Set<BrowserWindow>();
const claims=new DraftOwnership();
const popouts=new Map<string,BrowserWindow>();
const pendingLinks:string[]=[];
const pendingClose=new Set<number>();
const permittedClose=new Set<number>();
let main:BrowserWindow|undefined;
let service:Awaited<ReturnType<typeof createService>>;
let latestState:AppState|undefined;
let closing=false;
let quitting=false;
let activeIcon:string|undefined;

function trustedURL(raw:string):boolean{
  try{const url=new URL(raw);return devURL?url.origin===new URL(devURL).origin:url.protocol==='file:'&&url.pathname===rendererURL.pathname;}catch{return false;}
}
function assertCaller(event:IpcMainInvokeEvent){
  const frame=event.senderFrame;
  if(!frame||frame!==event.sender.mainFrame||!trustedURL(frame.url)||!BrowserWindow.fromWebContents(event.sender))throw new Error('Untrusted application window.');
}
function record(input:unknown):Record<string,unknown>{if(input===undefined)return {};if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('Invalid request.');return input as Record<string,unknown>;}
function text(input:unknown,label:string,max=10000):string{if(typeof input!=='string'||input.length>max)throw new Error(`Invalid ${label}.`);return input;}
async function external(raw:unknown){
  const value=text(raw,'link',10000);const url=new URL(value);
  if(!['https:','http:','mailto:'].includes(url.protocol)||url.username||url.password)throw new Error('Only web and email links can be opened.');
  await shell.openExternal(url.href);
}
function emit(event:Parameters<Listener>[0]){for(const win of windows)if(!win.isDestroyed())win.webContents.send('aplos:event',event);}
function command(value:string){const win=BrowserWindow.getFocusedWindow()||main;win?.webContents.send('aplos:event',{type:'command',payload:value});}
function focusMain(){if(!main||main.isDestroyed())main=createWindow();if(main.isMinimized())main.restore();main.show();main.focus();}
function handleLink(raw:string){try{const url=new URL(raw);if(!['mailto:','aplos:'].includes(url.protocol)||raw.length>10000)return;if(service)focusMain();if(!main||main.webContents.isLoading())pendingLinks.push(raw);else{focusMain();main.webContents.send('aplos:event',{type:'deep-link',payload:raw});}}catch{/* Ignore invalid OS links. */}}
function finishQuit(){if(closing)return;closing=true;void Promise.resolve(service?.close()).finally(()=>app.quit());}
// Runs on every state change. Assigning themeSource, even to the same value, resets the macOS app appearance
// and notifies theme observers, and the badge redraws the Dock tile, so only touch what actually changed.
let activeBadge=-1;
function applyAppearance(state:AppState){
  if(nativeTheme.themeSource!==state.settings.theme)nativeTheme.themeSource=state.settings.theme;
  const badge=state.settings.zen?0:state.threads.filter(thread=>thread.unread&&thread.status==='new').length;
  if(badge!==activeBadge){app.setBadgeCount(badge);activeBadge=badge;}
  if(process.platform==='darwin'&&activeIcon!==state.settings.icon){app.dock?.setIcon(join(__dirname,`icon-${state.settings.icon}.png`));activeIcon=state.settings.icon;}
}
function createWindow(query?:{draft?:string;thread?:string}){
  const mac=process.platform==='darwin';
  // macOS: a transparent window base lets the native sidebar material show through the
  // renderer's transparent sidebar; the content pane paints its own opaque surface.
  const chrome=mac?{titleBarStyle:'hidden' as const,trafficLightPosition:{x:16,y:14},backgroundColor:'#00000000',vibrancy:'sidebar' as const,visualEffectState:'followWindow' as const}:{titleBarStyle:'hiddenInset' as const,backgroundColor:nativeTheme.shouldUseDarkColors?'#000000':'#e6e5e2'};
  const win=new BrowserWindow({width:query?900:1360,height:query?800:900,minWidth:query?640:960,minHeight:560,title:'Aplos Mail',...chrome,show:false,icon:join(__dirname,'icon.png'),webPreferences:{preload:join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,spellcheck:true}});
  windows.add(win);
  let rendererReady=false;
  win.webContents.on('did-finish-load',()=>{rendererReady=true;});
  win.webContents.on('did-fail-load',()=>{rendererReady=false;});
  win.webContents.on('render-process-gone',()=>{rendererReady=false;});
  win.on('close',event=>{
    if(closing||permittedClose.has(win.id)||!rendererReady)return;
    event.preventDefault();
    if(pendingClose.has(win.id))return;
    pendingClose.add(win.id);win.setEnabled(false);
    win.webContents.send('aplos:event',{type:'prepare-close'});
  });
  win.webContents.on('will-prevent-unload',event=>{if(permittedClose.has(win.id)||closing)event.preventDefault();});
  win.once('ready-to-show',()=>win.show());
  win.webContents.on('will-navigate',(event,url)=>{if(!trustedURL(url)){event.preventDefault();void external(url).catch(()=>{});}});
  win.webContents.on('will-redirect',(event,url)=>{if(!trustedURL(url))event.preventDefault();});
  win.webContents.setWindowOpenHandler(({url})=>{void external(url).catch(()=>{});return {action:'deny'};});
  win.webContents.on('did-finish-load',()=>{if(latestState)win.webContents.send('aplos:event',{type:'state',payload:latestState});if(win===main)for(const link of pendingLinks.splice(0))win.webContents.send('aplos:event',{type:'deep-link',payload:link});});
  win.on('closed',()=>{windows.delete(win);pendingClose.delete(win.id);permittedClose.delete(win.id);for(const id of claims.releaseWindow(win.id))emit({type:'draft-owner',payload:{draftId:id}});for(const[key,popout]of popouts)if(popout===win)popouts.delete(key);if(main===win)main=undefined;if(quitting&&!windows.size)finishQuit();});
  if(devURL){const url=new URL(devURL);if(query)for(const[key,value]of Object.entries(query))url.searchParams.set(key,value);void win.loadURL(url.href);}
  else void win.loadFile(rendererFile,{query});
  return win;
}
function popout(kind:'draft'|'thread',id:string,fromWindowId:number){
  const key=`${kind}:${id}`;const existing=popouts.get(key);if(existing&&!existing.isDestroyed()){existing.show();existing.focus();return;}
  if(kind==='draft')claims.assertEditable(id,fromWindowId);
  const win=createWindow({[kind]:id});popouts.set(key,win);
  if(kind==='draft'){claims.transfer(id,fromWindowId,win.id);emit({type:'draft-owner',payload:{draftId:id,windowId:win.id}});}
}
function notify(title:string,body:string,threadId?:string){
  if(!Notification.isSupported())throw new Error('Desktop notifications are unavailable on this system.');
  const notification=new Notification({title,body,silent:!latestState?.settings.sendSound});
  notification.on('click',()=>{focusMain();if(threadId)main?.webContents.send('aplos:event',{type:'command',payload:`thread:${threadId}`});});notification.show();
}
function menus(){
  const item=(label:string,accelerator:string|undefined,value:string):MenuItemConstructorOptions=>({label,accelerator,click:()=>command(value)});
  const template:MenuItemConstructorOptions[]=[
    {label:app.name,submenu:[{role:'about'},item('Settings…','CmdOrCtrl+,','settings'),{type:'separator'},{role:'services'},{type:'separator'},{role:'hide'},{role:'hideOthers'},{role:'unhide'},{type:'separator'},{role:'quit'}]},
    {label:'File',submenu:[item('New Message','CmdOrCtrl+N','compose'),{type:'separator'},{role:'close'}]},
    {label:'Edit',submenu:[{role:'undo'},{role:'redo'},{type:'separator'},{role:'cut'},{role:'copy'},{role:'paste'},{role:'pasteAndMatchStyle'},{role:'selectAll'},{type:'separator'},item('Undo Mail Action','CmdOrCtrl+Shift+Z','undo')]},
    {label:'View',submenu:[item('Toggle Sidebar','CmdOrCtrl+Shift+S','toggle-sidebar'),item('Search Mail','CmdOrCtrl+K','search'),item('Ask Aplos','CmdOrCtrl+J','ask'),item('Refresh Mail','CmdOrCtrl+R','refresh'),{type:'separator'},item('Home','CmdOrCtrl+1','home'),item('Later','CmdOrCtrl+2','later'),item('All Mail','CmdOrCtrl+3','all'),item('Calendar','CmdOrCtrl+4','calendar'),{type:'separator'},{role:'resetZoom'},{role:'zoomIn'},{role:'zoomOut'},{role:'togglefullscreen'},...(!app.isPackaged?[{role:'toggleDevTools'} as MenuItemConstructorOptions]:[])]},
    {label:'Navigate',submenu:[item('Back','CmdOrCtrl+[','back'),item('Forward','CmdOrCtrl+]','forward')]},
    {role:'windowMenu'},
    {role:'help',submenu:[item('Keyboard Shortcuts','CmdOrCtrl+/','shortcuts'),{label:'About Aplos Mail',click:()=>{void dialog.showMessageBox({type:'info',title:'Aplos Mail',message:`Aplos Mail ${app.getVersion()}`,detail:'An independent desktop inbox. AI features use Groq. This build updates from its source distribution.'});}}]},
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
async function invokeNative(event:IpcMainInvokeEvent,method:string,input:unknown){
  const payload=record(input),win=BrowserWindow.fromWebContents(event.sender)!;
  if(method==='window.closeReady'){if(!pendingClose.has(win.id))return false;pendingClose.delete(win.id);permittedClose.add(win.id);win.setEnabled(true);setImmediate(()=>{if(!win.isDestroyed())win.close();});return true;}
  if(method==='window.closeCancel'){pendingClose.delete(win.id);win.setEnabled(true);quitting=false;return true;}
  if(method==='app.info')return {name:'Aplos Mail',version:app.getVersion(),desktop:true,update:'This build updates from source. Automatic updates are not configured.'};
  if(method==='shell.open'){await external(payload.url);return true;}
  if(method==='window.compose'){const id=text(payload.draftId,'draft ID',200);const state=await service.invoke('state.get') as AppState;if(!state.drafts.some(draft=>draft.id===id))throw new Error('Save this draft before opening a separate window.');popout('draft',id,win.id);return true;}
  if(method==='window.thread'){popout('thread',text(payload.threadId,'thread ID',200),win.id);return true;}
  if(method==='window.claim'){const id=text(payload.draftId,'draft ID',200);return claims.claim(id,win.id);}
  if(method==='window.release'){const id=text(payload.draftId,'draft ID',200);if(claims.release(id,win.id))emit({type:'draft-owner',payload:{draftId:id}});return true;}
  if(method==='file.save'||method==='file.open'){
    const name=basename(text(payload.name,'file name',255)).replace(/[\x00-\x1f]/g,'_')||'attachment';const encoded=text(payload.data,'file content',36*1024*1024);
    if(!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))throw new Error('Invalid attachment data.');const data=Buffer.from(encoded,'base64');if(data.length>25*1024*1024)throw new Error('Attachment exceeds 25 MB.');
    if(method==='file.save'){const result=await dialog.showSaveDialog(win,{defaultPath:name});if(result.canceled||!result.filePath)return {canceled:true};await writeFile(result.filePath,data);return {canceled:false,path:result.filePath};}
    if(!new Set(['.pdf','.txt','.md','.csv','.json','.eml','.ics','.png','.jpg','.jpeg','.gif','.webp','.heic','.doc','.docx','.xls','.xlsx','.ppt','.pptx','.rtf','.mp3','.mp4','.wav','.mov']).has(extname(name).toLowerCase()))throw new Error('Save this attachment to inspect it before opening.');
    const directory=await mkdtemp(join(tmpdir(),'aplos-attachment-'));const file=join(directory,name);await writeFile(file,data,{mode:0o600});const error=await shell.openPath(file);if(error)throw new Error(error);return true;
  }
  if(method==='notification.test'){notify('Aplos Mail','Notifications are ready.');return true;}
  if(method==='system.login'){if(typeof payload.enabled!=='boolean')throw new Error('Choose whether to launch at login.');app.setLoginItemSettings({openAtLogin:payload.enabled});return {enabled:app.getLoginItemSettings().openAtLogin};}
  if(method==='system.defaultMail'){const success=app.setAsDefaultProtocolClient('mailto');return {success};}
  if(method==='system.microphone'){if(process.platform!=='darwin')return {granted:true};return {granted:await systemPreferences.askForMediaAccess('microphone')};}
  throw new Error('Unsupported desktop method.');
}

app.setName('Aplos Mail');
const locked=app.requestSingleInstanceLock();
if(!locked)app.quit();
else{
  app.on('open-url',(event,url)=>{event.preventDefault();handleLink(url);});
  app.on('second-instance',(_event,argv)=>{focusMain();for(const arg of argv)if(/^(mailto|aplos):/i.test(arg))handleLink(arg);});
  app.on('activate',()=>{if(service)focusMain();});
  app.on('window-all-closed',()=>{if(process.platform!=='darwin')app.quit();});
  app.on('before-quit',event=>{if(service&&!closing){event.preventDefault();quitting=true;if(!windows.size)finishQuit();else for(const win of windows)win.close();}});
  void app.whenReady().then(async()=>{
    config({path:app.isPackaged?join(homedir(),'.config','aplos-mail','.env'):join(process.cwd(),'.env'),quiet:true});
    app.setAboutPanelOptions({applicationName:'Aplos Mail',applicationVersion:app.getVersion(),copyright:'Independent software. Built with original code and design.'});
    session.defaultSession.setPermissionCheckHandler((contents,permission)=>Boolean(contents&&trustedURL(contents.getURL())&&permission==='media'));
    session.defaultSession.setPermissionRequestHandler((contents,permission,callback,details)=>{
      const media=details as {mediaTypes?:string[]};
      if(!trustedURL(contents.getURL())||permission!=='media'||media.mediaTypes?.includes('video')){callback(false);return;}
      if(process.platform==='darwin')void systemPreferences.askForMediaAccess('microphone').then(callback).catch(()=>callback(false));else callback(true);
    });
    service=await createService({dataDir:process.env.APLOS_DATA_DIR||app.getPath('userData'),desktop:true,openExternal:external,
      symbolTool:app.isPackaged?join(process.resourcesPath,'bin','aplos-symbols'):join(__dirname,'..','bin','aplos-symbols'),
      encrypt:(value:string)=>{if(!safeStorage.isEncryptionAvailable())throw new Error('macOS secure credential storage is unavailable.');return safeStorage.encryptString(value);},
      decrypt:(value:Buffer)=>{if(!safeStorage.isEncryptionAvailable())throw new Error('Unlock macOS secure credential storage to connect your account.');return safeStorage.decryptString(value);}});
    service.subscribe((event:Parameters<Listener>[0])=>{
      if(event.type==='state'){latestState=event.payload as AppState;applyAppearance(latestState);}
      if(event.type==='reminder'){const payload=event.payload as {threadId:string;title:string};const thread=latestState?.threads.find(item=>item.id===payload.threadId);if(latestState?.settings.notifications&&(!thread||latestState.settings.accountNotifications[thread.accountId]!==false))notify('Aplos Mail reminder',payload.title,payload.threadId);}
      if(event.type==='notification'){const payload=event.payload as {title?:string;body?:string;threadId?:string};if(latestState?.settings.notifications)notify(payload.title||'Aplos Mail',payload.body||'You have a reminder.',payload.threadId);}
      emit(event);
    });
    ipcMain.handle('aplos:invoke',async(event,method:unknown,payload:unknown)=>{
      assertCaller(event);if(typeof method!=='string')throw new Error('Invalid application method.');
      if(nativeMethods.has(method))return invokeNative(event,method,payload);
      if(!methods.has(method))throw new Error('Unsupported application method.');
      const draftId=draftMutationId(method,payload);
      if(draftId)claims.assertEditable(draftId,BrowserWindow.fromWebContents(event.sender)!.id);
      return service.invoke(method,payload);
    });
    const initialState=await service.invoke('state.get') as AppState;
    latestState=initialState;
    applyAppearance(initialState);
    menus();main=createWindow();
    app.setAsDefaultProtocolClient('aplos');
    for(const arg of process.argv)if(/^(mailto|aplos):/i.test(arg))handleLink(arg);
  }).catch(error=>{dialog.showErrorBox('Aplos Mail could not start',error instanceof Error?error.message:'An unknown startup error occurred.');app.quit();});
}
