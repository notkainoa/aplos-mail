import { config } from 'dotenv';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Conversation } from '../src/shared/types';
import { createService } from '../src/main/service';
import { createGoogle } from '../src/main/google';
import { createGroq } from '../src/main/groq';
import { askModelIds } from '../src/shared/ask';

/**
 * An explicit live check of Ask's agent loop against Groq on fresh original demo mail in a temporary
 * folder. Nothing is sent and no real mailbox is touched. Usage: npm run eval:ask -- --model=openai/gpt-oss-20b
 */
config({quiet:true});
const groq=createGroq();
if(!groq.available)throw new Error('Set GROQ_API_KEY in the backend environment to run the live Ask check.');
const model=process.argv.find(a=>a.startsWith('--model='))?.slice(8)??askModelIds[0];
if(!askModelIds.includes(model))throw new Error(`Choose one of: ${askModelIds.join(', ')}`);
const dataDir=await mkdtemp(join(tmpdir(),'aplos-ask-live-'));
const service=await createService({dataDir,google:await createGoogle({dataDir,clientId:''}),groq});
let usage:{calls?:number;prompt?:number;completion?:number}={};
service.subscribe(event=>{const p=event.payload as {type?:string;step?:{tool:string;label:string;status:string}};if(event.type==='ai.progress'&&p?.type==='usage')usage=p;if(event.type==='ai.progress'&&p?.step?.tool==='wait'&&p.step.status==='running')console.log(`  … ${p.step.label}`);});
const questions:Array<[string,Record<string,unknown>?]>=[
  ['Summarize this',{context:{view:'home',threadId:'garden'}}],
  ['What does the invoice from Drew need from me?'],
  ['What plans do I have this week?'],
  ['Book lunch with Maya Friday at noon'],
  ['Move the Trail Journal newsletter and the Field Notes digest to Done'],
];
const only=process.argv.find(a=>a.startsWith('--only='))?.slice(7);
if(only)questions.splice(0,questions.length,...questions.filter((_,i)=>String(i+1)===only));
let failed=0;
try{
  await service.invoke('settings.update',{patch:{askModel:model}});
  const before=await service.invoke('state.get') as {drafts:unknown[];threads:{id:string;status:string}[]};
  for(const [message,extra] of questions){
    const started=performance.now();
    try{
      const conversation=await service.invoke('ai.ask',{message,timeZone:'America/Los_Angeles',...extra}) as Conversation;
      const answer=conversation.messages.at(-1)!;
      console.log(`\n» ${message}  (${Math.round(performance.now()-started)} ms, ${usage.calls} calls, ${usage.prompt} prompt + ${usage.completion} output tokens)`);
      for(const s of answer.steps??[])console.log(`  · ${s.label}${s.count!==undefined?` · ${s.count}`:''}${s.status==='error'?' (error)':''}`);
      console.log(`  ${answer.content.replace(/\n/g,'\n  ')}`);
      if(answer.citations?.length)console.log(`  cites: ${answer.citations.join(', ')}`);
      if(answer.proposal)console.log(`  draft card: to=${answer.proposal.to??''} subject=${answer.proposal.subject??''}`);
      if(answer.event)console.log(`  event card: ${answer.event.title} ${answer.event.start} → ${answer.event.end} guests=${answer.event.guests?.join(', ')}`);
      if(answer.triage)console.log(`  triage card: ${answer.triage.action} ${answer.triage.threadIds.join(', ')}`);
    }catch(error){failed++;console.log(`\n» ${message}\n  FAILED: ${(error as Error).message}`);}
  }
  const after=await service.invoke('state.get') as {drafts:unknown[];threads:{id:string;status:string}[]};
  const unchanged=JSON.stringify(after.drafts)===JSON.stringify(before.drafts)&&JSON.stringify(after.threads.map(t=>[t.id,t.status]))===JSON.stringify(before.threads.map(t=>[t.id,t.status]));
  console.log(`\n${model}: ${questions.length-failed}/${questions.length} answered; drafts and threads unchanged: ${unchanged}`);
}finally{await service.close();await rm(dataDir,{recursive:true,force:true});}
if(failed)process.exitCode=1;
