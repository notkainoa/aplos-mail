import test from 'node:test';
import assert from 'node:assert/strict';
import { createGroq, localNow } from '../src/main/groq';
import type { Thread } from '../src/shared/types';

const thread:Thread={id:'lunch',accountId:'personal',subject:'Lunch soon?',summary:'Leah suggests lunch',messages:[{id:'m1',from:'leah@garden.example',fromName:'Leah Park',to:['me@example.test'],text:'We should get lunch soon.',date:'2026-10-14T10:00:00Z',attachments:[]}],date:'2026-10-14T10:00:00Z',unread:false,status:'new',importance:'important',bookmarked:false,replyStatus:'none'};

function fake(answers:unknown[]){
  const sent:Record<string,unknown>[]=[];
  const groq=createGroq({apiKey:'synthetic-test-key',fetch:async(_url,init)=>{
    const body=JSON.parse(String(init?.body));sent.push({system:body.messages[0].content,...JSON.parse(body.messages[1].content)});
    return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(answers.shift())}}]}));
  }});
  return {groq,sent};
}

test('Ask event proposals resolve against the local clock and are strictly validated',async()=>{
  const now=new Date('2026-10-20T16:00:00Z');
  const clock=localNow('America/Los_Angeles',now);
  assert.deepEqual({...clock,upcoming:undefined},{now:'2026-10-20T09:00:00-07:00',weekday:'Tuesday',timeZone:'America/Los_Angeles',upcoming:undefined});
  assert.equal(clock.upcoming[2],'Friday 2026-10-23 -07:00');
  const london=localNow('Europe/London',now);assert.equal(london.upcoming[3],'Saturday 2026-10-24 +01:00');assert.equal(london.upcoming[6],'Tuesday 2026-10-27 +00:00');assert.equal(clock.upcoming.length,14);
  assert.equal(localNow('Not/AZone',now).timeZone,Intl.DateTimeFormat().resolvedOptions().timeZone);
  const valid={title:'Lunch with Leah',start:'2026-10-23T11:00:00-07:00',end:'2026-10-23T11:30:00-07:00',allDay:false,location:'Cafe',guests:['leah@garden.example','invented@nowhere.example','typed@friend.example','not an address']};
  const {groq,sent}=fake([
    {content:'Lunch is ready to review.',event:valid},
    {content:'x',event:{...valid,end:valid.start}},
    {content:'x',event:{...valid,start:'Friday at 11'}},
    {content:'x',event:{...valid,allDay:true,start:'2026-10-23T00:00:00Z',end:'2026-10-24'}},
    {content:'x',event:{...valid,title:'  '}},
    {content:'x',event:{...valid,allDay:true,start:'2026-02-30',end:'2026-03-01'}},
    {content:'x',event:{...valid,start:'2026-02-30T11:00:00-08:00',end:'2026-02-30T11:30:00-08:00'}},
    {content:'Off-site day.',event:{title:'Off-site',start:'2026-10-23',end:'2026-10-24',allDay:true}},
  ]);
  const contacts=Array.from({length:80},(_,i)=>({name:`Person ${i}`,email:`p${i}@example.test`}));
  const ask=(q:string)=>groq.ask([{role:'user',content:q}],[thread],undefined,{timeZone:'America/Los_Angeles',contacts,now});
  const answer=await ask('Book lunch with Leah Friday at 11am and invite typed@friend.example');
  assert.deepEqual(answer.event,{title:'Lunch with Leah',start:valid.start,end:valid.end,allDay:false,location:'Cafe',description:'',guests:['leah@garden.example','typed@friend.example']});
  // The clock and a bounded contact list reach Groq alongside the usual mailbox context.
  assert.equal((sent[0].clock as {now:string}).now,'2026-10-20T09:00:00-07:00');
  assert.equal((sent[0].contacts as unknown[]).length,50);
  assert.match(String(sent[0].system),/event\?:\{title,start,end,allDay/);
  for(const q of ['ends before it starts','unparseable','all-day with a time','no title','impossible day','impossible timed day'])assert.equal((await ask(q)).event,undefined,q);
  assert.deepEqual((await ask('Block Friday')).event?.start,'2026-10-23');
});
