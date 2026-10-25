import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createService } from '../../src/main/service';
import { createGoogle } from '../../src/main/google';
import { createMicrosoft } from '../../src/main/microsoft';
import { createGroq } from '../../src/main/groq';
import { startProviderEmulator } from './providers';
import type { MailProvider, ProviderKind } from '../../src/engine/provider';
import type { Thread } from '../../src/shared/types';

function disabledProvider(kind:ProviderKind):MailProvider {
  const reject=async():Promise<never>=>{throw new Error('Only local Google and Outlook emulators are available in this session.');};
  return {kind,available:false,unavailableReason:'Only local Google and Outlook emulators are enabled.',capabilities:()=>({labels:false,importance:false,aliases:false,signatures:false,calendar:false,serverSearch:false}),connect:reject,disconnect:reject,sync:reject,search:reject,updateThread:reject,findSent:reject,send:reject,attachment:reject,close(){}};
}

function emulatedAI(){
  const base=createGroq({apiKey:''});
  return {...base,get available(){return true;},
    summarize:async(t:Thread,signal?:AbortSignal)=>{await new Promise(r=>setTimeout(r,250));if(signal?.aborted)throw new Error('AI request cancelled.');return {summary:`Emulated summary: ${t.subject.toLowerCase()}`,importance:'important' as const};}};
}

/** All tokens and mail are synthetic; the temporary encryption key dies with this session. */
/** `fakeAI` stands in a local summarizer (labelled "Emulated", a short delay per email) so the AI pass can be watched without a key. */
export async function createEmulatedSession(liveAI=false,{demo=true,threads=0,latencyMs=0,fakeAI=false}:{demo?:boolean;threads?:number;latencyMs?:number;fakeAI?:boolean}={}) {
  const dataDir=await mkdtemp(join(tmpdir(),'aplos-emulated-')),key=randomBytes(32);
  const emulator=await startProviderEmulator({threads,latencyMs});
  const encrypt=(text:string)=>{const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);const bytes=Buffer.concat([cipher.update(text,'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),bytes]);};
  const decrypt=(bytes:Buffer)=>{const cipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));cipher.setAuthTag(bytes.subarray(12,28));return Buffer.concat([cipher.update(bytes.subarray(28)),cipher.final()]).toString();};
  return {dataDir,emulator,
    createService:()=>createService({demo,dataDir,encrypt,decrypt,openExternal:emulator.authorize,fetch:emulator.fetch,autoSyncMs:0,
      groq:fakeAI?emulatedAI():createGroq(liveAI?{}:{apiKey:''}),
      // Every provider request uses the emulator, including OAuth and token refresh.
      providers:{
        google:env=>createGoogle({...env,fetch:emulator.fetch,clientId:'emulated-aplos',clientSecret:'',oauthTimeoutMs:5000}),
        microsoft:env=>createMicrosoft({...env,fetch:emulator.fetch,clientId:'emulated-aplos',oauthTimeoutMs:5000}),
        imap:disabledProvider('imap'),jmap:disabledProvider('jmap'),
      },
    }),
    async close(){await emulator.close();key.fill(0);await rm(dataDir,{recursive:true,force:true});},
  };
}
