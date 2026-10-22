import {useSyncExternalStore} from 'react';
import type {Thread} from '../shared/types';
import {bridge,invoke} from './bridge';
import {hasRealSummary} from '../shared/summary';
export {describeSummaryError,hasRealSummary,summaryProvider,type SummaryProvider} from './summaryText';

/**
 * Summaries requested from the reader or the list this session. Opening an email whose summary is only its own text
 * asks once; a failure stays on the card (with its reason) until Retry, so reopening the email doesn't ask again.
 */
export type SummaryJob={running:boolean;error?:string;done?:boolean};
const jobs=new Map<string,SummaryJob>();
/** Emails the engine reports being summarized, including those from sync. */
const working=new Set<string>();
const listeners=new Set<()=>void>();
const notify=()=>{for(const listener of listeners)listener();};
const set=(id:string,job:SummaryJob)=>{jobs.set(id,job);notify();};
let watching=false;
function watch(){
  if(watching)return;watching=true;
  bridge.subscribe(event=>{
    if(event.type!=='ai.summarizing')return;
    const {threadId,active}=event.payload as {threadId:string;active:boolean};
    if(active)working.add(threadId);else working.delete(threadId);notify();
  });
}
const subscribe=(listener:()=>void)=>{watch();listeners.add(listener);return ()=>{listeners.delete(listener);};};
export function useSummaryJob(threadId:string){return useSyncExternalStore(subscribe,()=>jobs.get(threadId));}
/** Whether this email's summary is being written right now, whoever asked. */
export function useSummarizing(threadId:string){return useSyncExternalStore(subscribe,()=>working.has(threadId)||!!jobs.get(threadId)?.running);}

/** Resolves to the error message, or undefined once the thread has a fresh summary. A call while one is running does nothing. */
export async function summarize(threadId:string):Promise<string|undefined>{
  if(jobs.get(threadId)?.running)return;
  set(threadId,{running:true});
  try{await invoke('ai.summarize',{threadId});set(threadId,{running:false,done:true});return;}
  catch(error){const message=error instanceof Error&&error.message?error.message:'The AI provider could not summarize this email.';set(threadId,{running:false,error:message});return message;}
}
/** Summarize on open, once per session; a retry is the user's call. */
export function summarizeIfNeeded(thread:Thread){if(!hasRealSummary(thread)&&!jobs.has(thread.id))void summarize(thread.id);}

// Rows on screen without a summary are summarized two at a time. After a failure (often no key or a rate limit)
// the list waits a minute before going on with the rest; opening an email still asks, and shows why it failed.
const queue:string[]=[];let active=0,pausedUntil=0,resume:ReturnType<typeof setTimeout>|undefined;
export function summarizeRow(thread:Thread){
  if(hasRealSummary(thread)||jobs.has(thread.id)||queue.includes(thread.id))return;
  queue.push(thread.id);pump();
}
function pump(){
  const wait=pausedUntil-Date.now();
  if(wait>0){resume??=setTimeout(()=>{resume=undefined;pump();},wait);return;}
  while(active<2&&queue.length){
    const id=queue.shift()!;if(jobs.has(id))continue;
    active++;void summarize(id).then(error=>{if(error)pausedUntil=Date.now()+60_000;}).finally(()=>{active--;pump();});
  }
}
