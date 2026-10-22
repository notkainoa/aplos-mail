import test from 'node:test';
import assert from 'node:assert/strict';
import {providerRequest} from '../src/main/llm';
import {describeSummaryError,hasRealSummary} from '../src/renderer/summaryText';
import type {Thread} from '../src/shared/types';

const groq=(status:number,headers:Record<string,string>={},key='test')=>providerRequest({name:'Groq',env:'GROQ_API_KEY',baseUrl:'https://groq.example',apiKey:key,fetch:async()=>new Response('{}',{status,headers})},'chat',undefined).then(()=>'',(error:Error)=>error.message);

test('every Groq failure the summary card can hit gets its own reason',async()=>{
  const messages=[await groq(200,{},''),await groq(401),await groq(402),await groq(429),await groq(429,{'retry-after':'600'}),await groq(404),
    'Groq could not complete the request. Check your connection and try again.','Groq returned an invalid response. Please try again.'];
  const titles=messages.map(message=>describeSummaryError(message).title);
  assert.ok(!titles.includes('Something went wrong'),titles.join(' | '));
  assert.equal(new Set(titles).size,titles.length);
  assert.equal(describeSummaryError('Groq request failed (500). Please try again.').title,'Something went wrong');
});

test('a summary that is only the email’s own text does not count',()=>{
  const thread=(summary:string)=>({summary,messages:[{text:'Hi Alex,\nWe are gathering at the garden this Saturday at 10 am.'}]}) as Thread;
  assert.equal(hasRealSummary(thread('We are gathering at the garden this Saturday…')),false);
  assert.equal(hasRealSummary(thread('')),false);
  assert.equal(hasRealSummary(thread('Help plant the herb beds Saturday at 10 am')),true);
});
