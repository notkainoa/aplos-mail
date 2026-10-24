import {app,BrowserWindow,clipboard,dialog,ipcMain,Menu,Notification,safeStorage,shell,systemPreferences,nativeTheme,session,utilityProcess,type IpcMainInvokeEvent,type MenuItemConstructorOptions} from 'electron';
import {config} from 'dotenv';
import {loadDevEnv} from './env';
import {writeFile,mkdtemp} from 'node:fs/promises';
import {join,basename,extname,resolve} from 'node:path';
import {homedir,tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {connectEngine,type EngineInit} from './engine-rpc';
import {createCipher,loadDataKey,migrateCredentials} from './keyring';
import {applyChanges,type StateChanges} from '../shared/live';
import {DraftOwnership,draftMutationId} from './desktop-policy';
import {UpdateController,disabledReason,teamIdentifier,type Updater} from './updates';
import {spawnSync} from 'node:child_process';
import type {AppState,Listener} from '../shared/types';

const methods=new Set([
  'state.get','threads.page','capabilities.get','symbols.render','settings.update','account.select','account.connect','account.discover','domain.check','account.disconnect','sync','demo.reset',
  'thread.update','thread.undo','home.hide','search','draft.save','draft.delete','draft.send','draft.undoSend',
  'ai.summarize','ai.summarizing','ai.polish','ai.draft','ai.ask','ai.models','ai.test','ai.keys','ai.key.set','ai.key.delete','ai.key.test','ai.cancel','ai.transcribe','conversation.delete','workflow.status','workflow.enable','workflow.code','workflow.disable',
  'calendar.list','calendar.extract','calendar.save','calendar.delete','attachment.get','sender.block','sender.unblock','thread.unsubscribe','data.export',
]);
const nativeMethods=new Set(['window.compose','window.thread','window.claim','window.release','window.closeReady','window.closeCancel','shell.open','file.save','file.open','notification.test','system.login','system.defaultMail','system.microphone','app.info','update.status','update.check','update.restart','update.later']);
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
type Engine=ReturnType<typeof connectEngine>;
/** The mailbox engine in its utility process; replaced if that process stops unexpectedly. */
let service:Engine|undefined;
let started=false;
const restarts:number[]=[];
let latestState:AppState|undefined;
let closing=false;
let quitting=false;
let updates:UpdateController|undefined;
/** Set by Restart: the normal quit (drafts saved, engine closed) ends by installing the update instead of quitting. */
let installUpdate=false;

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
function handleLink(raw:string){try{const url=new URL(raw);if(!['mailto:','aplos:'].includes(url.protocol)||raw.length>10000)return;if(started)focusMain();if(!main||main.webContents.isLoading())pendingLinks.push(raw);else{focusMain();main.webContents.send('aplos:event',{type:'deep-link',payload:raw});}}catch{/* Ignore invalid OS links. */}}
function finishQuit(){if(closing)return;closing=true;void Promise.resolve(service?.close()).finally(()=>{updates?.stop();if(!(installUpdate&&updates?.install()))app.quit();});}
// Runs on every state change. Assigning themeSource, even to the same value, resets the macOS app appearance
// and notifies theme observers, and the badge redraws the Dock tile, so only touch what actually changed.
let activeBadge=-1,activeTheme:AppState['settings']['theme']|undefined,syncingTheme=false;
function applyAppearance(state:AppState){
  if(activeTheme!==state.settings.theme){activeTheme=state.settings.theme;syncTheme(true);}
  const badge=state.settings.zen?0:state.threads.filter(thread=>thread.unread&&thread.status==='new').length;
  if(badge!==activeBadge){app.setBadgeCount(badge);activeBadge=badge;}
}
// The macOS sidebar material can keep the appearance it was drawn with when a change slips past it,
// leaving dark glass under light-theme text (or the reverse). When the setting or the system
// appearance changes, re-assert the app appearance if it drifted and redraw the material;
// when a window comes forward, do so only if it drifted.
function syncTheme(redraw:boolean){
  if(!activeTheme||syncingTheme)return;
  syncingTheme=true;
  try{
    const drifted=activeTheme!=='system'&&nativeTheme.shouldUseDarkColors!==(activeTheme==='dark');
    if(drifted&&nativeTheme.themeSource===activeTheme)nativeTheme.themeSource='system';
    if(nativeTheme.themeSource!==activeTheme)nativeTheme.themeSource=activeTheme;
    if(process.platform==='darwin'&&(redraw||drifted))for(const win of windows)if(!win.isDestroyed()){win.setVibrancy(null);win.setVibrancy('sidebar');}
  }finally{syncingTheme=false;}
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
  win.on('focus',()=>syncTheme(false));
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
    {label:app.name,submenu:[{role:'about'},{label:'Check for Updates…',click:()=>void checkManually()},item('Settings…','CmdOrCtrl+,','settings'),{type:'separator'},{role:'services'},{type:'separator'},{role:'hide'},{role:'hideOthers'},{role:'unhide'},{type:'separator'},{role:'quit'}]},
    {label:'File',submenu:[item('New Message','CmdOrCtrl+N','compose'),{type:'separator'},{role:'close'}]},
    {label:'Edit',submenu:[{role:'undo'},{role:'redo'},{type:'separator'},{role:'cut'},{role:'copy'},{role:'paste'},{role:'pasteAndMatchStyle'},{role:'selectAll'},{type:'separator'},item('Undo Mail Action','CmdOrCtrl+Shift+Z','undo')]},
    {label:'View',submenu:[item('Toggle Sidebar','CmdOrCtrl+Shift+S','toggle-sidebar'),item('Search Mail','CmdOrCtrl+K','search'),item('Ask Aplos','CmdOrCtrl+J','ask'),item('Refresh Mail','CmdOrCtrl+R','refresh'),{type:'separator'},item('Home','CmdOrCtrl+1','home'),item('Later','CmdOrCtrl+2','later'),item('All Mail','CmdOrCtrl+3','all'),item('Calendar','CmdOrCtrl+4','calendar'),{type:'separator'},{role:'resetZoom'},{role:'zoomIn'},{role:'zoomOut'},{role:'togglefullscreen'},...(!app.isPackaged?[{role:'toggleDevTools'} as MenuItemConstructorOptions]:[])]},
    {label:'Navigate',submenu:[item('Back','CmdOrCtrl+[','back'),item('Forward','CmdOrCtrl+]','forward')]},
    {role:'windowMenu'},
    {role:'help',submenu:[item('Keyboard Shortcuts','CmdOrCtrl+/','shortcuts'),{label:'About Aplos Mail',click:()=>{void dialog.showMessageBox({type:'info',title:'Aplos Mail',message:`Aplos Mail ${app.getVersion()}`,detail:'An independent desktop inbox. AI features use Groq by default, or the providers you choose in Settings.'});}}]},
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
/** The running .app bundle (…/Aplos Mail.app/Contents/MacOS/Aplos Mail → …/Aplos Mail.app). */
function bundlePath(){return resolve(process.execPath,'..','..','..');}
function createUpdates(){
  const devFeed=!app.isPackaged&&process.env.APLOS_UPDATE_DEV==='1';
  const log=(line:string)=>console.log(`Aplos Mail: ${line}`);
  const disabled=disabledReason({platform:process.platform,packaged:app.isPackaged,devFeed,bundlePath:bundlePath(),teamId:()=>{
    const result=spawnSync('/usr/bin/codesign',['--display','--verbose=2',bundlePath()],{encoding:'utf8'});
    return teamIdentifier(`${result.stdout}\n${result.stderr}`);
  }});
  return new UpdateController({currentVersion:app.getVersion(),disabled,log,emit:info=>emit({type:'update',payload:info}),updater:()=>{
    // Loaded only when updates can run, so development and unsigned builds never start electron-updater.
    const {autoUpdater}=require('electron-updater') as typeof import('electron-updater');
    autoUpdater.logger={info:(m:unknown)=>log(`updater: ${String(m)}`),warn:(m:unknown)=>log(`updater warning: ${String(m)}`),error:(m:unknown)=>log(`updater error: ${String(m)}`),debug:()=>{}};
    // dev-app-update.yml in apps/desktop points at `npm run update-feed`.
    if(devFeed)autoUpdater.forceDevUpdateConfig=true;
    return autoUpdater as unknown as Updater;
  }});
}
function restartToUpdate(){
  if(!updates?.ready)return;
  installUpdate=true;app.quit();
}
async function checkManually(){
  if(!updates)return;
  const info=await updates.check(true),status=info.status;
  const show=(message:string,detail?:string)=>void dialog.showMessageBox({type:'info',title:'Aplos Mail',message,detail});
  if(status.state==='current')show('You’re up to date',`Aplos Mail ${info.currentVersion} is the newest version.`);
  else if(status.state==='downloading')show(`Aplos Mail ${status.version} is downloading`,'You can restart to update when it is ready.');
  else if(status.state==='ready'){focusMain();}
  else if(status.state==='disabled')show('Automatic updates are off',status.reason);
  else if(status.state==='error')show('Couldn’t check for updates',status.message);
}
async function invokeNative(event:IpcMainInvokeEvent,method:string,input:unknown){
  const payload=record(input),win=BrowserWindow.fromWebContents(event.sender)!;
  // Also accepts the save acknowledgement from a renderer-initiated close held at beforeunload.
  if(method==='window.closeReady'){pendingClose.delete(win.id);permittedClose.add(win.id);win.setEnabled(true);setImmediate(()=>{if(!win.isDestroyed())win.close();});return true;}
  if(method==='window.closeCancel'){pendingClose.delete(win.id);win.setEnabled(true);quitting=false;installUpdate=false;return true;}
  if(method==='app.info')return {name:'Aplos Mail',version:app.getVersion(),desktop:true};
  if(method==='update.status')return updates!.info();
  if(method==='update.check')return updates!.check(true);
  if(method==='update.later'){updates!.later();return updates!.info();}
  if(method==='update.restart'){restartToUpdate();return true;}
  if(method==='shell.open'){await external(payload.url);return true;}
  if(method==='window.compose'){const id=text(payload.draftId,'draft ID',200);if(!latestState?.drafts.some(draft=>draft.id===id))throw new Error('Save this draft before opening a separate window.');popout('draft',id,win.id);return true;}
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
  if(method==='system.microphone'){
    if(process.platform!=='darwin')return {granted:true,status:'granted'};
    // `check` reports the current permission without showing the macOS prompt.
    if(payload.check===true){const status=systemPreferences.getMediaAccessStatus('microphone');return {granted:status==='granted',status};}
    const granted=await systemPreferences.askForMediaAccess('microphone');return {granted,status:systemPreferences.getMediaAccessStatus('microphone')};
  }
  throw new Error('Unsupported desktop method.');
}

function engineEvent(event:Parameters<Listener>[0]){
  if(event.type==='changes'){const changes=event.payload as StateChanges;if(latestState?.epoch===changes.epoch){latestState=applyChanges(latestState,changes);applyAppearance(latestState);}}
  if(event.type==='reminder'){const payload=event.payload as {threadId:string;title:string};const thread=latestState?.threads.find(item=>item.id===payload.threadId);if(latestState?.settings.notifications&&(!thread||latestState.settings.accountNotifications[thread.accountId]!==false))notify('Aplos Mail reminder',payload.title,payload.threadId);}
  if(event.type==='notification'){const payload=event.payload as {title?:string;body?:string;threadId?:string};if(latestState?.settings.notifications)notify(payload.title||'Aplos Mail',payload.body||'You have a reminder.',payload.threadId);}
  emit(event);
}
/** Unwrap the credential key with the keychain and re-seal credentials saved before it existed. */
async function engineInit(dataDir:string):Promise<EngineInit>{
  const init:EngineInit={dataDir,symbolTool:app.isPackaged?join(process.resourcesPath,'bin','aplos-symbols'):join(__dirname,'..','bin','aplos-symbols')};
  const keychain={available:()=>safeStorage.isEncryptionAvailable(),encrypt:(value:string)=>safeStorage.encryptString(value),decrypt:(value:Buffer)=>safeStorage.decryptString(value)};
  try{init.key=await loadDataKey(dataDir,keychain);}
  catch(error){init.keyError=error instanceof Error?error.message:'macOS secure credential storage is unavailable.';return init;}
  // A credential file that fails to migrate only affects its own accounts, so the key is still handed over.
  const report=(file:string,error:unknown)=>console.error(`Aplos Mail: could not re-seal ${file}: ${error instanceof Error?error.message:String(error)}`);
  await migrateCredentials(dataDir,keychain.decrypt,createCipher(init.key),report).catch(error=>report('credentials',error));
  return init;
}
async function startEngine(init:EngineInit):Promise<Engine>{
  const child=utilityProcess.fork(join(__dirname,'engine.cjs'),[],{serviceName:'Aplos Mail Engine',env:process.env});
  const engine=connectEngine({post:message=>child.postMessage(message),listen:handler=>child.on('message',handler)},init,async(method,args)=>{
    if(method==='openExternal'){await external(args[0]);return true;}
    throw new Error('Unsupported engine request.');
  });
  engine.subscribe(engineEvent);
  let exited=false;
  child.once('exit',()=>{
    exited=true;
    // Before ready this also rejects `started`, so the caller of a failed start does the accounting.
    engine.fail(new Error('The mailbox stopped unexpectedly. Aplos is reopening it.'));
    if(service!==engine||closing)return;
    service=undefined;restartEngine(init);
  });
  try{await engine.started;}
  catch(error){if(!exited)child.kill();throw error;}
  return engine;
}
/** Replace a stopped engine. Failed starts count too, so a crash loop ends in a dialog instead of retrying forever. */
function restartEngine(init:EngineInit,lastError?:unknown){
  if(closing)return;
  const now=Date.now();restarts.push(now);while(restarts.length&&now-restarts[0]>60_000)restarts.shift();
  if(restarts.length>3){
    const detail=lastError instanceof Error?` (${lastError.message})`:'';
    dialog.showErrorBox('Aplos Mail stopped',`The mailbox keeps stopping unexpectedly${detail}. Quit and reopen Aplos Mail.`);return;
  }
  void startEngine(init).then(next=>{
    if(closing){void next.close();return;}
    service=next;
    void next.invoke('state.get').then(state=>{latestState=state as AppState;applyAppearance(latestState);emit({type:'state',payload:latestState});},()=>{/* If it stopped, its exit handler restarts it. */});
  },error=>{setTimeout(()=>restartEngine(init,error),1000);});
}

app.setName('Aplos Mail');
const locked=app.requestSingleInstanceLock();
if(!locked)app.quit();
else{
  app.on('open-url',(event,url)=>{event.preventDefault();handleLink(url);});
  app.on('second-instance',(_event,argv)=>{focusMain();for(const arg of argv)if(/^(mailto|aplos):/i.test(arg))handleLink(arg);});
  app.on('activate',()=>{if(started)focusMain();});
  app.on('window-all-closed',()=>{if(process.platform!=='darwin')app.quit();});
  app.on('before-quit',event=>{if(started&&!closing){event.preventDefault();quitting=true;if(!windows.size)finishQuit();else for(const win of windows)win.close();}});
  void app.whenReady().then(async()=>{
    // A packaged app shows its bundle icon (AppIcon.icon); a development run would otherwise show Electron's.
    if(!app.isPackaged)app.dock?.setIcon(join(__dirname,'icon.png'));
    if(app.isPackaged)config({path:join(homedir(),'.config','aplos-mail','.env'),quiet:true});else loadDevEnv();
    app.setAboutPanelOptions({applicationName:'Aplos Mail',applicationVersion:app.getVersion(),copyright:'Independent software. Built with original code and design.'});
    session.defaultSession.setPermissionCheckHandler((contents,permission)=>Boolean(contents&&trustedURL(contents.getURL())&&permission==='media'));
    session.defaultSession.setPermissionRequestHandler((contents,permission,callback,details)=>{
      const media=details as {mediaTypes?:string[]};
      if(!trustedURL(contents.getURL())||permission!=='media'||media.mediaTypes?.includes('video')){callback(false);return;}
      if(process.platform==='darwin')void systemPreferences.askForMediaAccess('microphone').then(callback).catch(()=>callback(false));else callback(true);
    });
    service=await startEngine(await engineInit(process.env.APLOS_DATA_DIR||app.getPath('userData')));
    ipcMain.handle('aplos:invoke',async(event,method:unknown,payload:unknown)=>{
      assertCaller(event);if(typeof method!=='string')throw new Error('Invalid application method.');
      // Paste reads the clipboard here and hands the key straight to the engine, so it never passes through the renderer.
      if(method==='ai.key.paste'){if(!service)throw new Error('The mailbox is restarting. Try again in a moment.');return service.invoke('ai.key.set',{provider:(payload as {provider?:unknown}|undefined)?.provider,key:clipboard.readText()});}
      if(nativeMethods.has(method))return invokeNative(event,method,payload);
      if(!methods.has(method))throw new Error('Unsupported application method.');
      const draftId=draftMutationId(method,payload);
      if(draftId)claims.assertEditable(draftId,BrowserWindow.fromWebContents(event.sender)!.id);
      if(!service)throw new Error('The mailbox is restarting. Try again in a moment.');
      return service.invoke(method,payload);
    });
    latestState=await service.invoke('state.get') as AppState;
    applyAppearance(latestState);started=true;
    nativeTheme.on('updated',()=>syncTheme(true));
    updates=createUpdates();updates.start();
    menus();main=createWindow();
    app.setAsDefaultProtocolClient('aplos');
    for(const arg of process.argv)if(/^(mailto|aplos):/i.test(arg))handleLink(arg);
  }).catch(error=>{dialog.showErrorBox('Aplos Mail could not start',error instanceof Error?error.message:'An unknown startup error occurred.');app.quit();});
}
