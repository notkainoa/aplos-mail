import {useSyncExternalStore} from 'react';
import type {Thread} from '../shared/types';
import {invoke} from './bridge';
import {hasRealSummary} from '../shared/summary';
export {describeSummaryError,hasRealSummary,summaryProvider,type SummaryProvider} from './summaryText';

/**
 * Summaries requested from the reader this session. Opening an email whose summary is only its own text asks Groq
 * once; a failure stays on the card (with its reason) until Retry, so reopening the email doesn't ask again.
 */
export type SummaryJob={running:boolean;error?:string;done?:boolean};
const jobs=new Map<string,SummaryJob>();
const listeners=new Set<()=>void>();
const set=(id:string,job:SummaryJob)=>{jobs.set(id,job);for(const listener of listeners)listener();};
const subscribe=(listener:()=>void)=>{listeners.add(listener);return ()=>{listeners.delete(listener);};};
export function useSummaryJob(threadId:string){return useSyncExternalStore(subscribe,()=>jobs.get(threadId));}

/** Resolves to the error message, or undefined once the thread has a fresh summary. A call while one is running does nothing. */
export async function summarize(threadId:string):Promise<string|undefined>{
  if(jobs.get(threadId)?.running)return;
  set(threadId,{running:true});
  try{await invoke('ai.summarize',{threadId});set(threadId,{running:false,done:true});return;}
  catch(error){const message=error instanceof Error&&error.message?error.message:'Groq could not summarize this email.';set(threadId,{running:false,error:message});return message;}
}
/** Summarize on open, once per session; a retry is the user's call. */
export function summarizeIfNeeded(thread:Thread){if(!hasRealSummary(thread)&&!jobs.has(thread.id))void summarize(thread.id);}
