import {contextBridge,ipcRenderer} from 'electron';
import type {Bridge,Listener} from '../shared/types';

const allowed = new Set([
  'state.get','capabilities.get','settings.update','account.select','account.connect','account.discover','domain.check','account.disconnect','sync','demo.reset',
  'thread.update','thread.undo','home.hide','search','draft.save','draft.delete','draft.send','draft.undoSend',
  'ai.summarize','ai.polish','ai.draft','ai.ask','ai.cancel','ai.transcribe','conversation.delete',
  'calendar.list','calendar.extract','calendar.save','calendar.delete','attachment.get','sender.block','sender.unblock','thread.unsubscribe','data.export',
  'window.compose','window.thread','window.claim','window.release','window.closeReady','window.closeCancel','shell.open','file.save','file.open','notification.test',
  'system.login','system.defaultMail','system.microphone','app.info','symbols.render',
]);
const listeners=new Set<Listener>();
const queued:Parameters<Listener>[0][]=[];
ipcRenderer.on('aplos:event',(_event:Electron.IpcRendererEvent,event:Parameters<Listener>[0])=>{
  if(!listeners.size&&(event.type==='deep-link'||event.type==='command'||event.type==='prepare-close')){queued.push(event);if(queued.length>50)queued.shift();}
  for(const listener of listeners)listener(event);
});
const bridge:Bridge = {
  invoke: async <T>(method:string,payload?:unknown):Promise<T> => {
    if(!allowed.has(method)) throw new Error('Unsupported application method.');
    return ipcRenderer.invoke('aplos:invoke',method,payload) as Promise<T>;
  },
  subscribe: (listener:Listener) => {
    listeners.add(listener);
    for(const event of queued.splice(0))listener(event);
    return ()=>{listeners.delete(listener);};
  },
};
contextBridge.exposeInMainWorld('aplos',bridge);
