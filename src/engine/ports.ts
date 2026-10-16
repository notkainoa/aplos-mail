import type { Account, AppState, AskMessage, CalendarEvent, Draft, Thread } from '../shared/types';
import type { MailProvider, ProviderKind, ProviderMemory } from './provider';
import type { MailStore, MemoryWrite, OpChanges, SaveExtras, StoreDiff } from './store';
import type { WorkflowPatch } from './workflow';

/** Storage and host services the platform-free orchestration receives from its host. */
export interface ServiceStore extends Omit<MailStore,'load'|'save'> {
  read():AppState|undefined;
  write(state:AppState,ops?:OpChanges,extras?:SaveExtras):StoreDiff;
}

/** Async context belongs to the host; a mobile host must preserve it across overlapping requests. */
export interface MemoryStage {
  run<T>(fn:()=>T):T;
  /** Undefined means a concurrent writer changed a key; discard and repeat the operation. */
  writes():MemoryWrite[]|undefined;
  committed():void;
  discard():void;
}
export interface StagedMemory { memory:ProviderMemory; stage():MemoryStage }

/** Groq is the sole implementation. Configuration and secrets belong to the host. */
export interface Intelligence {
  readonly available:boolean;
  summarize(thread:Thread,signal?:AbortSignal):Promise<Partial<Thread>>;
  polish(html:string,instruction?:string,signal?:AbortSignal):Promise<{html:string}>;
  draft(instruction:string,thread?:Thread,draft?:Partial<Draft>,signal?:AbortSignal):Promise<Partial<Draft>>;
  ask(messages:AskMessage[],threads:Thread[],signal?:AbortSignal):Promise<AskMessage>;
  extractEvents(thread:Thread,signal?:AbortSignal):Promise<Partial<CalendarEvent>[]>;
  transcribe(audio:string,mimeType:string,signal?:AbortSignal):Promise<{text:string}>;
}

/** The encrypted workflow transport is injected together with its platform vault and crypto. */
export interface WorkflowSync {
  readonly enabled:boolean;
  enable(code?:string):Promise<string>;
  code():string|undefined;
  hasEdits(accountId:string):boolean;
  disable(accountIds:string[]):Promise<void>;
  noteEdits(threads:Thread[]):void;
  round(account:Account,provider:MailProvider,threads:()=>Thread[]):Promise<WorkflowPatch[]>;
}

export interface EngineOptions {
  store:ServiceStore;
  staged:StagedMemory;
  providers:Partial<Record<ProviderKind,MailProvider>>;
  brokenProviders?:Map<ProviderKind,string>;
  groq:Intelligence;
  workflow?:WorkflowSync;
  workflowError?:string;
  /** Whether the injected workflow vault has secure credential storage. */
  secure:boolean;
  randomUUID:()=>string;
  symbols?:(items:unknown,scale:unknown)=>Promise<Record<string,string>>;
  now?:()=>Date;
  desktop?:boolean;
  fetch?:typeof fetch;
  lookup?:(host:string)=>Promise<string[]>;
  autoSyncMs?:number;
}
