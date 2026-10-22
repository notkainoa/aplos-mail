import type {Thread} from './types';

const flat=(text:string)=>text.replace(/\s+/g,' ').replace(/(…|\.\.\.)$/,'').trim().toLowerCase();
/** Until Groq summarizes a synced thread, its summary is just the Gmail snippet; that isn't a summary worth showing. */
export function hasRealSummary(thread:Thread){return !!thread.summary?.trim()&&!thread.messages.some(m=>flat(m.text).includes(flat(thread.summary)));}
