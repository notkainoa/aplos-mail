import type { AccountPreset, ProviderCapabilities, ProviderKind, ServerSettings } from '../engine/provider';
export type View = 'home'|'later'|'all'|'drafts'|'sent'|'needs-reply'|'awaiting-reply'|'trash'|'spam'|'low'|'calendar'|'settings';
export interface SendAs { email:string; name:string; signature:string; isDefault:boolean }
export interface Account { id:string; name:string; email:string; color:string; provider:'demo'|ProviderKind; connected:boolean; error?:string; calendarConnected?:boolean; sendAs?:SendAs[]; preset?:AccountPreset; server?:ServerSettings; capabilities?:ProviderCapabilities }
export interface Attachment { id:string; name:string; type:string; size:number; data?:string; contentId?:string; remoteId?:string; messageId?:string }
export interface Message { id:string; from:string; fromName:string; to:string[]; cc?:string[]; date:string; text:string; html?:string; quoted?:string; attachments:Attachment[]; sent?:boolean; internetId?:string; references?:string }
export interface Thread { id:string; accountId:string; subject:string; summary:string; messages:Message[]; date:string; unread:boolean; status:'new'|'done'|'later'|'trash'|'spam'; importance:'important'|'low'; bookmarked:boolean; replyStatus:'none'|'needs-reply'|'awaiting-reply'; dueDate?:string; reminderAt?:string; reminderFired?:boolean; todo?:string; hiddenFromHome?:boolean; remoteId?:string; labels?:string[] }
export interface Draft { id:string; accountId:string; fromEmail?:string; signatureSource?:'custom'|'account'; to:string; cc:string; bcc:string; subject:string; html:string; attachments:Attachment[]; threadId?:string; mode:'new'|'reply'|'reply-all'|'forward'; updatedAt:string; signature:boolean; pendingSendAt?:string; sendError?:string; revision:number; messageId?:string; sendAttemptAt?:string }
export interface CalendarEvent { id:string; accountId:string; threadId?:string; calendarId:string; title:string; start:string; end:string; allDay:boolean; location:string; description:string; guests:string[]; remoteId?:string; url?:string }
export interface Settings { theme:'light'|'dark'|'system'; zen:boolean; openMode:'stack'|'split'; sidebar:boolean; triageDirection:'done-right'|'done-left'; swipe:boolean; doneAction:'archive'|'read'|'unread'; laterAction:'archive'|'read'|'unread'; lowAction:'archive'|'read'|'unread'; defaultReply:'reply'|'reply-all'; signature:string; signatureMode:'always'|'new'|'never'; footer:boolean; autoPolish:boolean; undoSeconds:number; sendSound:boolean; autoCalendar:boolean; gmailEvents:boolean; notifications:boolean; accountNotifications:Record<string,boolean>; microphone:string; icon:'ink'|'sage'|'clay'; launchAtLogin:boolean; remoteImages:boolean; onboardingDone:boolean }
export interface AskMessage { role:'user'|'assistant'; content:string; citations?:string[]; proposal?:Partial<Draft> }
export interface Conversation { id:string; title:string; messages:AskMessage[]; updatedAt:string }
export interface AppState { version:1; accounts:Account[]; threads:Thread[]; drafts:Draft[]; events:CalendarEvent[]; conversations:Conversation[]; settings:Settings; selectedAccountId:string; sync:{busy:boolean; lastSync?:string; error?:string; pending?:number}; blockedSenders:string[];
  /** Engine run and commit count of this copy; not saved. */ epoch?:string; rev?:number;
  /** Total threads when this copy holds only the newest ones. */ threadCount?:number }
export interface Capabilities { groq:boolean; google:boolean; microsoft:boolean; desktop:boolean; version:string }
export type Listener = (event:{type:string; payload?:unknown})=>void;
export interface Bridge { invoke<T=unknown>(method:string,payload?:unknown):Promise<T>; subscribe(listener:Listener):()=>void }
declare global { interface Window { aplos?:Bridge } }
