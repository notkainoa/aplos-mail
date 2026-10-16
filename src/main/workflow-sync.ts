import { randomUUID } from 'node:crypto';
import type { Account, Thread } from '../shared/types';
import type { MailProvider, ProviderMemory } from '../engine/provider';
import { keySchemeFor, parseWorkflowLog, reconcileWorkflow, type WorkflowLog, type WorkflowPatch } from '../engine/workflow';
import { generateSyncCode, normalizeSyncCode, openWorkflow, sealWorkflow, WorkflowCryptoError } from './workflow-crypto';
import { createVault } from './vault';

/** Provider memory key for the device's own ID, kept under a pseudo-account that no disconnect clears. */
const DEVICE='aplos-device';
const KNOWN='workflow.known',EDITED='workflow.edited';

export interface WorkflowSyncOptions {
  dataDir:string;
  encrypt?:(value:string)=>Buffer;
  decrypt?:(value:Buffer)=>string;
  memory:ProviderMemory;
  now:()=>Date;
}

/**
 * Done, Later, todos, due dates and reminders, shared between devices through each account's hidden
 * "Aplos" folder. The sync code is the only key; it stays in the credential vault and never reaches
 * the host. Edits are remembered until a round has recorded them, so quitting in between loses nothing.
 */
export async function createWorkflowSync(options:WorkflowSyncOptions) {
  const vault=await createVault<string>({dataDir:options.dataDir,encrypt:options.encrypt,decrypt:options.decrypt,file:'workflow-sync.enc.json'});
  const {memory}=options;
  let device=memory.get(DEVICE,'id');
  if(!device){device=randomUUID();memory.set(DEVICE,'id',device);}
  const edited=(accountId:string)=>{try{const ids=JSON.parse(memory.get(accountId,EDITED)??'[]');return new Set<string>(Array.isArray(ids)?ids:[]);}catch{return new Set<string>();}};
  const known=(accountId:string):WorkflowLog|undefined=>{const raw=memory.get(accountId,KNOWN);if(!raw)return;try{return parseWorkflowLog(JSON.parse(raw));}catch{return undefined;}};
  return {
    get enabled(){return vault.get('code')!==undefined;},
    /** Turn sync on with the code from another device, or a new code for the first device. */
    async enable(code?:string):Promise<string> {
      if(!vault.secure)throw new Error('Syncing between devices needs the Aplos Mail desktop app.');
      const value=code===undefined?generateSyncCode():normalizeSyncCode(code);
      await vault.set('code',value);
      return value;
    },
    code:()=>vault.get('code'),
    hasEdits:(accountId:string)=>edited(accountId).size>0,
    async disable(accountIds:string[]) {
      await vault.delete('code');
      for(const id of accountIds){memory.set(id,KNOWN,undefined);memory.set(id,EDITED,undefined);}
    },
    /** Remember threads whose workflow fields the user changed, for the next round of their account. */
    noteEdits(threads:Array<Pick<Thread,'id'|'accountId'>>) {
      if(vault.get('code')===undefined)return;
      const byAccount=new Map<string,string[]>();
      for(const t of threads)byAccount.set(t.accountId,[...(byAccount.get(t.accountId)??[]),t.id]);
      for(const [accountId,ids] of byAccount){const set=edited(accountId);for(const id of ids)set.add(id);memory.set(accountId,EDITED,JSON.stringify([...set].slice(-20_000)));}
    },
    /**
     * Read the account's synced log, merge this device's edits into it, write it back when it changed,
     * and return the patches other devices' edits imply for local threads.
     */
    async round(account:Account, provider:MailProvider, threads:()=>Thread[]):Promise<WorkflowPatch[]> {
      const code=vault.get('code');
      if(!code||!provider.readAppData||!provider.writeAppData)return [];
      const pending=edited(account.id);
      const blob=await provider.readAppData(account);
      let remote:WorkflowLog|undefined,replace=false;
      if(blob!==undefined){
        try{remote=openWorkflow(blob,code);}
        catch(error){
          // Damaged data is replaced; a different code or a newer format belongs to another device and is left alone.
          if(error instanceof WorkflowCryptoError&&error.reason==='damaged')replace=true;else throw error;
        }
      }
      const all=threads().filter(t=>t.accountId===account.id);
      const result=reconcileWorkflow({known:known(account.id),remote,edited:all.filter(t=>pending.has(t.id)),threads:all,device:device!,now:options.now().getTime(),scheme:keySchemeFor(account.provider)});
      if(result.write||replace)await provider.writeAppData(account,sealWorkflow(result.log,code));
      memory.set(account.id,KNOWN,JSON.stringify(result.log));
      // Edits made while this round ran stay queued for the next one.
      const left=edited(account.id);for(const id of pending)left.delete(id);
      memory.set(account.id,EDITED,left.size?JSON.stringify([...left]):undefined);
      return result.patches;
    },
  };
}
