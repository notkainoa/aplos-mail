import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppState, Conversation } from '../src/shared/types';
import type { ChatRequest } from '../src/engine/agent';
import type { ChatProvider } from '../src/engine/ports';
import { createService } from '../src/main/service';
import { createGoogle } from '../src/main/google';
import { createGroq } from '../src/main/groq';
import { createOpenCodeGo, createOpenRouter } from '../src/main/providers';
import { parseAskModel } from '../src/shared/ask';

const sse=(lines:string[])=>new Response(new ReadableStream<Uint8Array>({start(c){c.enqueue(new TextEncoder().encode(lines.join('\n')+'\n'));c.close();}}));
const data=(value:unknown)=>`data: ${JSON.stringify(value)}\n`;
type Seen={url:string;headers:Record<string,string>;body?:Record<string,any>};
function recorder(reply:(url:string)=>Response){
  const seen:Seen[]=[];
  const fetch:typeof globalThis.fetch=async(input,init)=>{seen.push({url:String(input),headers:{...(init?.headers as Record<string,string>)},...(init?.body?{body:JSON.parse(String(init.body))}:{})});return reply(String(input));};
  return {fetch,seen};
}
const request:ChatRequest={model:'anthropic/claude-haiku-5.5',session:'conv-1',messages:[{role:'user',content:'hi'}],tools:[{name:'search_mail',description:'',parameters:{type:'object'}}]};

test('OpenRouter streams through comments and its usage chunk, names the app and sends tools on every call',async()=>{
  const {fetch,seen}=recorder(()=>sse([': OPENROUTER PROCESSING','',data({choices:[{delta:{content:'Hello'}}]}),'',data({choices:[{delta:{},finish_reason:'stop'}],usage:{prompt_tokens:12,completion_tokens:3}}),'','data: [DONE]']));
  const turn=await createOpenRouter({apiKey:'or-test',fetch}).chat(request,{});
  assert.equal(turn.content,'Hello');assert.deepEqual(turn.usage,{prompt:12,completion:3});
  assert.equal(seen[0].url,'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(seen[0].headers.Authorization,'Bearer or-test');assert.equal(seen[0].headers['X-OpenRouter-Title'],'Aplos Mail');
  assert.equal(seen[0].body!.model,'anthropic/claude-haiku-5.5');assert.equal(seen[0].body!.tools.length,1);assert.equal(seen[0].body!.reasoning_effort,undefined);
  // A provider failure arrives as a 200 stream with an error chunk; it is an error, without the provider's wording.
  const failing=recorder(()=>sse([data({error:{code:'server_error',message:'Provider disconnected unexpectedly'},choices:[{delta:{content:''},finish_reason:'error'}]})]));
  await assert.rejects(createOpenRouter({apiKey:'k',fetch:failing.fetch}).chat(request,{}),(e:Error)=>/OpenRouter stopped/.test(e.message)&&!/disconnected/.test(e.message));
  const broke=recorder(()=>new Response(JSON.stringify({error:{code:402,message:'Insufficient credits'}}),{status:402}));
  await assert.rejects(createOpenRouter({apiKey:'k',fetch:broke.fetch}).chat(request,{}),/OpenRouter has no credits left/);
  await assert.rejects(createOpenRouter({apiKey:'',fetch}).chat(request,{}),/OPENROUTER_API_KEY/);
});

test('OpenRouter lists only tool-capable models, curated picks first',async()=>{
  const {fetch}=recorder(()=>new Response(JSON.stringify({data:[
    {id:'zeta/plain-chat',name:'Zeta: Plain',supported_parameters:['temperature'],pricing:{prompt:'0.000001',completion:'0.000002'}},
    {id:'alpha/tooly',name:'Alpha: Tooly',supported_parameters:['tools','tool_choice'],pricing:{prompt:'0.0000005',completion:'0.000002'}},
    {id:'anthropic/claude-haiku-5.5',name:'Anthropic: Claude Haiku 5.5',supported_parameters:['tools'],pricing:{prompt:'0.0000001',completion:'0.0000005'}},
  ]})));
  const models=await createOpenRouter({apiKey:'k',fetch}).models!();
  assert.deepEqual(models.map(m=>m.id),['anthropic/claude-haiku-5.5','alpha/tooly']);
  assert.equal(models[0].label,'Claude Haiku 5.5');assert.equal(models[1].label,'Tooly');assert.equal(models[1].description,'$0.50 in · $2 out per million tokens');
});

test('OpenCode Go uses its chat endpoint with its own user agent and a session per conversation',async()=>{
  const {fetch,seen}=recorder(url=>url.endsWith('/models')
    ?new Response(JSON.stringify({data:[{id:'kimi-k3'},{id:'glm-5.3'},{id:'claude-haiku-5-5'},{id:'qwen3.8-max'}]}))
    :sse([data({choices:[{delta:{tool_calls:[{index:0,id:'c1',function:{name:'search_mail',arguments:'{"query":"x"}'}}]}}]})]));
  const go=createOpenCodeGo({apiKey:'go-test',fetch,version:'9.9.9'});
  const turn=await go.chat({...request,model:'kimi-k3'},{});
  assert.deepEqual(turn.toolCalls,[{id:'c1',name:'search_mail',arguments:'{"query":"x"}'}]);
  assert.equal(seen[0].url,'https://opencode.ai/inference/go/openai/v1/chat/completions');
  assert.equal(seen[0].headers['User-Agent'],'aplos-mail/9.9.9');assert.equal(seen[0].headers['x-opencode-session'],'conv-1');assert.equal(seen[0].headers.Authorization,'Bearer go-test');
  // Models Go serves through other APIs (Anthropic- or Responses-style) are not offered.
  assert.deepEqual((await go.models!()).map(m=>m.id),['kimi-k3','glm-5.3']);
  assert.equal(go.available,true);assert.equal(createOpenCodeGo({apiKey:''}).available,false);
});

test('the Ask setting picks the provider; a missing key says which variable to set; old Groq IDs migrate',async()=>{
  const dataDir=await mkdtemp(join(tmpdir(),'aplos-providers-'));
  const asked:ChatRequest[]=[];
  const fake:ChatProvider={available:true,chat:async req=>{asked.push(req);return {content:'From OpenRouter.',toolCalls:[]};},models:async()=>[{id:'anthropic/claude-haiku-5.5',label:'Claude Haiku 5.5'}]};
  const service=await createService({dataDir,google:await createGoogle({dataDir,clientId:''}),groq:createGroq({apiKey:''}),chats:{openrouter:fake,'opencode-go':{available:false,chat:fake.chat}}});
  try{
    await service.invoke('settings.update',{patch:{askModel:'openai/gpt-oss-20b'}});
    assert.equal((await service.invoke('state.get') as AppState).settings.askModel,'groq:openai/gpt-oss-20b');
    await assert.rejects(service.invoke('settings.update',{patch:{askModel:'mystery:model'}}),/Choose an Ask model/);
    await service.invoke('settings.update',{patch:{askModel:'openrouter:anthropic/claude-haiku-5.5'}});
    const result=await service.invoke('ai.ask',{message:'Hello'}) as Conversation;
    assert.equal(result.messages[1].content,'From OpenRouter.');assert.equal(result.messages[1].model,'openrouter:anthropic/claude-haiku-5.5');
    assert.equal(asked[0].model,'anthropic/claude-haiku-5.5');assert.equal(asked[0].session,result.id);
    await service.invoke('settings.update',{patch:{askModel:'opencode-go:kimi-k3'}});
    await assert.rejects(service.invoke('ai.ask',{message:'Hello'}),/Add OPENCODE_API_KEY .* OpenCode Go/);
    const catalog=await service.invoke('ai.models') as Array<{id:string;available:boolean;models:{id:string}[]}>;
    assert.deepEqual(catalog.map(p=>[p.id,p.available]),[['groq',false],['openrouter',true],['opencode-go',false]]);
    assert.deepEqual(catalog[1].models.map(m=>m.id),['anthropic/claude-haiku-5.5']);
    // The connection check asks for one tool call and reports whether the model made it.
    const fakeCalls:ChatRequest[]=[];fake.chat=async req=>{fakeCalls.push(req);return {content:'',toolCalls:[{id:'p',name:'ping',arguments:'{}'}]};};
    const check=await service.invoke('ai.test',{model:'openrouter:anthropic/claude-haiku-5.5'}) as {ms:number;tools:boolean};
    assert.equal(check.tools,true);assert.equal(fakeCalls[0].tools?.[0].name,'ping');assert.equal(fakeCalls[0].model,'anthropic/claude-haiku-5.5');
    await assert.rejects(service.invoke('ai.test',{model:'opencode-go:kimi-k3'}),/OPENCODE_API_KEY/);
  }finally{await service.close();await rm(dataDir,{recursive:true,force:true});}
  assert.deepEqual(parseAskModel('openrouter:qwen/qwen3.8-flash:free'),{provider:'openrouter',model:'qwen/qwen3.8-flash:free'});
});
