import {useSyncExternalStore} from 'react';
import type {CalendarEvent} from '../shared/types';

/**
 * Plans Groq already found in an email this session (from Space on a suggestion, "Find plans in this email"
 * or the Calendar's "From your mail"). Today shows them beside the open email without asking Groq again.
 */
const plans=new Map<string,Partial<CalendarEvent>[]>();
const listeners=new Set<()=>void>();
export function rememberPlans(threadId:string,found:Partial<CalendarEvent>[]){plans.set(threadId,found);for(const listener of listeners)listener();}
const subscribe=(listener:()=>void)=>{listeners.add(listener);return ()=>{listeners.delete(listener);};};
export function usePlans(threadId:string|undefined){return useSyncExternalStore(subscribe,()=>threadId?plans.get(threadId):undefined);}
