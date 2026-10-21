import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { createStore } from './store';
import { createGroq } from './groq';
import { createOpenCodeGo, createOpenRouter } from './providers';
import type { ChatProvider } from '../engine/ports';
import type { AskProviderId } from '../shared/ask';
import { createGoogle, type GoogleAdapter } from './google';
import { symbolRenderer } from './symbols';
import { createStagedMemory } from './memory-stage';
import type { MailProvider, ProviderEnvironment, ProviderKind } from '../engine/provider';
import { createMicrosoft } from './microsoft';
import { createImap } from './imap';
import { createJmap } from './jmap';
import { createCalDav } from './caldav';
import { createWorkflowSync } from './workflow-sync';
import { createEngineService } from '../engine/service';

type Groq = ReturnType<typeof createGroq>;
export interface ServiceOptions {
  dataDir:string; desktop?:boolean; encrypt?:(text:string)=>Buffer; decrypt?:(cipher:Buffer)=>string;
  openExternal?:(url:string)=>Promise<unknown>; groq?:Groq; google?:GoogleAdapter; now?:()=>Date; symbolTool?:string;
  /** Ask's OpenRouter and OpenCode Go transports; tests pass fakes. */
  chats?:Partial<Record<AskProviderId,ChatProvider>>;
  /** Mail hosts by kind, or factories given the service's provider environment; missing kinds use the built-in adapters. */
  providers?:Partial<Record<ProviderKind,MailProvider|((env:ProviderEnvironment<Buffer>)=>MailProvider|Promise<MailProvider>)>>;
  /** Network access for discovery and DNS checks; tests pass a fake. */
  fetch?:typeof fetch;
  /** Background sync interval for connected accounts; 0 turns it off. */
  autoSyncMs?:number;
}

/** Desktop composition root. The service itself depends only on the engine's typed ports. */
export async function createService(options:ServiceOptions) {
  const now=options.now||(()=>new Date());
  const store=createStore(options.dataDir);
  const staged=createStagedMemory(store.memory);
  const env:ProviderEnvironment<Buffer>={dataDir:options.dataDir,encrypt:options.encrypt,decrypt:options.decrypt,openExternal:options.openExternal,fetch:options.fetch,memory:staged.memory};
  const providers:Partial<Record<ProviderKind,MailProvider>>={};
  for(const [kind,given] of Object.entries(options.providers??{}) as Array<[ProviderKind,MailProvider|((env:ProviderEnvironment<Buffer>)=>MailProvider|Promise<MailProvider>)]>)providers[kind]=typeof given==='function'?await given(env):given;
  providers.google??=options.google||await createGoogle({dataDir:options.dataDir,encrypt:options.encrypt,decrypt:options.decrypt,openExternal:options.openExternal});
  /** Why a built-in adapter failed to start; one unreadable credential file must not stop the app or the other hosts. */
  const brokenProviders=new Map<ProviderKind,string>();
  const builtIn:Array<[ProviderKind,()=>Promise<MailProvider>]>=[
    ['microsoft',()=>createMicrosoft(env)],
    ['imap',()=>createImap({...env,calendar:createCalDav({fetch:options.fetch})})],
    ['jmap',()=>createJmap(env)],
  ];
  await Promise.all(builtIn.filter(([kind])=>!providers[kind]).map(async([kind,make])=>{
    try{providers[kind]=await make();}catch(error){brokenProviders.set(kind,error instanceof Error?error.message:'This account type could not start.');}
  }));
  let workflow:Awaited<ReturnType<typeof createWorkflowSync>>|undefined,workflowError:string|undefined;
  try{workflow=await createWorkflowSync({dataDir:options.dataDir,encrypt:options.encrypt,decrypt:options.decrypt,memory:staged.memory,now});}
  catch(error){workflowError=error instanceof Error?error.message:'Device sync could not start.';}
  return createEngineService({
    store,staged,providers,brokenProviders,workflow,workflowError,now,
    groq:options.groq||createGroq(),randomUUID,
    chats:{openrouter:createOpenRouter(),'opencode-go':createOpenCodeGo(),...options.chats},symbols:symbolRenderer(options.symbolTool),
    desktop:options.desktop,secure:!!options.encrypt,fetch:options.fetch,
    lookup:options.fetch?undefined:async host=>(await lookup(host,{all:true})).map(a=>a.address),
    autoSyncMs:options.autoSyncMs,
  });
}
