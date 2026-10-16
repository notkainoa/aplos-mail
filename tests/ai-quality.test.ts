import test from 'node:test';
import assert from 'node:assert/strict';
import { createGroq } from '../src/main/groq';
import { qualityThread } from '../scripts/quality/cases';

test('Ask preserves a complete bounded context, the latest question, and only citations actually supplied to Groq',async()=>{
  const threads=Array.from({length:101},(_,i)=>qualityThread(`evidence-${i}`,'Original context. '.repeat(300)));
  let sent:{messages:Array<{role:string;content:string}>}|undefined;
  const ai=createGroq({apiKey:'synthetic-test-key',fetch:async(_url,init)=>{
    sent=JSON.parse(String(init?.body));
    return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({content:'A bounded answer.',citations:['evidence-0','evidence-100','invented']})}}]}));
  }});
  const answer=await ai.ask([...Array.from({length:19},()=>({role:'assistant' as const,content:'Old conversation. '.repeat(3000)})),{role:'user',content:'What is the latest approved studio plan?'}],threads);
  const input=JSON.parse(sent!.messages.find(m=>m.role==='user')!.content);
  assert.equal(input.messages.at(-1).content,'What is the latest approved studio plan?');
  assert.ok(sent!.messages.find(m=>m.role==='user')!.content.length<=100000);
  assert.ok(input.mailbox.length>0&&input.mailbox.length<101);
  assert.deepEqual(answer.citations,['evidence-0']);
  assert.ok(answer.citations!.every(id=>input.mailbox.some((t:{id:string})=>t.id===id)));
});
