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
import { createCustom, createGemini, createLmStudio, createOpenAI, createOpenCodeGo, createOpenRouter } from '../src/main/providers';
import { createOllama } from '../src/main/ollama';
import { createClaude } from '../src/main/anthropic';
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
    assert.deepEqual(catalog.map(p=>p.id),['groq','openai','anthropic','gemini','openrouter','opencode-go','ollama','lmstudio','custom']);
    assert.deepEqual(catalog.filter(p=>['groq','openrouter','opencode-go','custom'].includes(p.id)).map(p=>[p.id,p.available]),[['groq',false],['openrouter',true],['opencode-go',false],['custom',false]]);
    assert.deepEqual(catalog.find(p=>p.id==='openrouter')!.models.map(m=>m.id),['anthropic/claude-haiku-5.5']);
    // The connection check asks for one tool call and reports whether the model made it.
    const fakeCalls:ChatRequest[]=[];fake.chat=async req=>{fakeCalls.push(req);return {content:'',toolCalls:[{id:'p',name:'ping',arguments:'{}'}]};};
    const check=await service.invoke('ai.test',{model:'openrouter:anthropic/claude-haiku-5.5'}) as {ms:number;tools:boolean};
    assert.equal(check.tools,true);assert.equal(fakeCalls[0].tools?.[0].name,'ping');assert.equal(fakeCalls[0].model,'anthropic/claude-haiku-5.5');
    await assert.rejects(service.invoke('ai.test',{model:'opencode-go:kimi-k3'}),/OPENCODE_API_KEY/);
  }finally{await service.close();await rm(dataDir,{recursive:true,force:true});}
  assert.deepEqual(parseAskModel('openrouter:qwen/qwen3.8-flash:free'),{provider:'openrouter',model:'qwen/qwen3.8-flash:free'});
});

test('ChatGPT, Gemini and a custom server use their own endpoints and quirks',async()=>{
  const ok=()=>sse([data({choices:[{delta:{content:'ok'}}]})]);
  const openai=recorder(url=>url.endsWith('/models')?new Response(JSON.stringify({data:[{id:'gpt-6-luna'},{id:'gpt-image-2'},{id:'text-embedding-4'},{id:'gpt-7-preview'}]})):ok());
  const gpt=createOpenAI({apiKey:'oa',fetch:openai.fetch});
  await gpt.chat({...request,model:'gpt-6-luna'},{});
  assert.equal(openai.seen[0].url,'https://api.openai.com/v1/chat/completions');
  assert.equal(openai.seen[0].body!.temperature,undefined,'OpenAI reasoning models reject a temperature');assert.equal(openai.seen[0].body!.reasoning_effort,'low');
  assert.deepEqual((await gpt.models!()).map(m=>m.id),['gpt-6-luna','gpt-7-preview']);
  const google=recorder(url=>url.endsWith('/models')?new Response(JSON.stringify({data:[{id:'models/gemini-3.8-flash'},{id:'models/gemini-embedding-2'}]})):ok());
  const gemini=createGemini({apiKey:'gm',fetch:google.fetch});
  await gemini.chat({...request,model:'gemini-3.8-flash'},{});
  assert.equal(google.seen[0].url,'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');assert.equal(google.seen[0].headers.Authorization,'Bearer gm');
  assert.deepEqual((await gemini.models!()).map(m=>m.id),['gemini-3.8-flash']);
  const local=recorder(()=>ok());
  const server=createCustom('http://localhost:11434/v1/',{apiKey:'',fetch:local.fetch});
  assert.equal(server.available,true,'a local server needs no key');
  await server.chat({...request,model:'llama3.3'},{});
  assert.equal(local.seen[0].url,'http://localhost:11434/v1/chat/completions');assert.equal(local.seen[0].headers.Authorization,undefined);
});

test('Claude streams text, maps tool calls both ways and replays its own blocks',async()=>{
  const events=(list:Array<[string,unknown]>)=>new Response(list.map(([event,body])=>`event: ${event}\ndata: ${JSON.stringify(body)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
  const message={id:'msg_1',type:'message',role:'assistant',model:'claude-haiku-5-5',content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:20,output_tokens:0}};
  const bodies:Record<string,any>[]=[];
  const fetch:typeof globalThis.fetch=async(_url,init)=>{bodies.push(JSON.parse(String(init?.body)));return events(bodies.length===1?[
    ['message_start',{type:'message_start',message}],
    ['content_block_start',{type:'content_block_start',index:0,content_block:{type:'thinking',thinking:'',signature:''}}],
    ['content_block_delta',{type:'content_block_delta',index:0,delta:{type:'signature_delta',signature:'sig'}}],
    ['content_block_stop',{type:'content_block_stop',index:0}],
    ['content_block_start',{type:'content_block_start',index:1,content_block:{type:'text',text:''}}],
    ['content_block_delta',{type:'content_block_delta',index:1,delta:{type:'text_delta',text:'Let me look.'}}],
    ['content_block_stop',{type:'content_block_stop',index:1}],
    ['content_block_start',{type:'content_block_start',index:2,content_block:{type:'tool_use',id:'toolu_1',name:'search_mail',input:{}}}],
    ['content_block_delta',{type:'content_block_delta',index:2,delta:{type:'input_json_delta',partial_json:'{"query":"inv'}}],
    ['content_block_delta',{type:'content_block_delta',index:2,delta:{type:'input_json_delta',partial_json:'oice"}'}}],
    ['content_block_stop',{type:'content_block_stop',index:2}],
    ['message_delta',{type:'message_delta',delta:{stop_reason:'tool_use',stop_sequence:null},usage:{output_tokens:30}}],
    ['message_stop',{type:'message_stop'}],
  ]:[
    ['message_start',{type:'message_start',message}],
    ['message_delta',{type:'message_delta',delta:{stop_reason:'refusal',stop_sequence:null},usage:{output_tokens:1}}],
    ['message_stop',{type:'message_stop'}],
  ]);};
  const claude=createClaude({apiKey:'sk-test',fetch});
  const text:string[]=[];
  const turn=await claude.chat({model:'claude-haiku-5-5',messages:[{role:'system',content:'rules'},{role:'user',content:'invoice?'}],tools:request.tools,toolChoice:'auto'},{onText:t=>text.push(t)});
  assert.deepEqual(text,['Let me look.']);assert.equal(turn.content,'Let me look.');
  assert.deepEqual(turn.toolCalls,[{id:'toolu_1',name:'search_mail',arguments:'{"query":"invoice"}'}]);
  assert.equal(bodies[0].system,'rules');assert.equal(bodies[0].tools[0].input_schema.type,'object');assert.deepEqual(bodies[0].tool_choice,{type:'auto'});assert.equal(bodies[0].stream,true);
  // The next call replays Claude's own blocks (thinking signature included) and returns results in one user turn.
  await assert.rejects(claude.chat({model:'claude-haiku-5-5',messages:[{role:'system',content:'rules'},{role:'user',content:'invoice?'},
    {role:'assistant',content:'Let me look.',raw:turn.raw,tool_calls:[{id:'toolu_1',type:'function',function:{name:'search_mail',arguments:'{"query":"invoice"}'}}]},
    {role:'tool',tool_call_id:'toolu_1',name:'search_mail',content:'{"total":1}'},{role:'system',content:'Answer now.'}],tools:request.tools,toolChoice:'none'},{}),/Claude declined/);
  const replay=bodies[1].messages;
  assert.deepEqual(replay[1].content.map((b:{type:string})=>b.type),['thinking','text','tool_use']);assert.equal(replay[1].content[0].signature,'sig');
  assert.deepEqual(replay[2].content.map((b:{type:string})=>b.type),['tool_result','text']);assert.equal(replay[2].content[0].tool_use_id,'toolu_1');
  assert.deepEqual(bodies[1].tool_choice,{type:'none'});
  assert.equal(createClaude({apiKey:''}).available,false);
});

test('a custom server address must be http or https and routes Ask to that server',async()=>{
  const dataDir=await mkdtemp(join(tmpdir(),'aplos-custom-'));
  const asked:string[]=[];
  const service=await createService({dataDir,google:await createGoogle({dataDir,clientId:''}),groq:createGroq({apiKey:''}),serverChat:(_id,url)=>({available:true,chat:async req=>{asked.push(`${url}|${req.model}`);return {content:'Local answer.',toolCalls:[]};}})});
  try{
    await service.invoke('settings.update',{patch:{askModel:'custom:llama3.3'}});
    await assert.rejects(service.invoke('ai.ask',{message:'Hi'}),/server’s address/);
    await assert.rejects(service.invoke('settings.update',{patch:{askCustomUrl:'file:///etc/passwd'}}),/http or https/);
    await assert.rejects(service.invoke('settings.update',{patch:{askCustomUrl:'http://user:pw@localhost:1/v1'}}),/http or https/);
    await service.invoke('settings.update',{patch:{askCustomUrl:'http://localhost:11434/v1'}});
    const result=await service.invoke('ai.ask',{message:'Hi'}) as Conversation;
    assert.equal(result.messages[1].content,'Local answer.');assert.deepEqual(asked,['http://localhost:11434/v1|llama3.3']);
  }finally{await service.close();await rm(dataDir,{recursive:true,force:true});}
});

test('Ollama: native chat with a larger context, tool calls both ways, tool-capable models and a clear offline message',async()=>{
  const seen:{url:string;body?:any}[]=[];
  const ndjson=(lines:unknown[])=>new Response(lines.map(l=>JSON.stringify(l)).join('\n')+'\n');
  const fetch:typeof globalThis.fetch=async(input,init)=>{
    const url=String(input);seen.push({url,...(init?.body?{body:JSON.parse(String(init.body))}:{})});
    if(url.endsWith('/api/version'))return new Response(JSON.stringify({version:'0.13.2'}));
    if(url.endsWith('/api/tags'))return new Response(JSON.stringify({models:[{name:'qwen3:latest',details:{parameter_size:'8.2B',quantization_level:'Q4_K_M'}},{name:'nomic-embed-text:latest'},{name:'old-model:7b'}]}));
    if(url.endsWith('/api/show')){const model=JSON.parse(String(init?.body)).model;return new Response(JSON.stringify(model.startsWith('qwen3')?{capabilities:['completion','tools','thinking']}:model.startsWith('nomic')?{capabilities:['embedding']}:{}));}
    if(JSON.parse(String(init?.body)).model==='missing')return new Response(JSON.stringify({error:'model "missing" not found, try pulling it first'}),{status:404});
    return ndjson([{message:{role:'assistant',content:'Looking'},done:false},{message:{role:'assistant',content:'.'},done:false},
      {message:{role:'assistant',content:'',tool_calls:[{function:{name:'search_mail',arguments:{query:'invoice'}}}]},done:false},
      {message:{role:'assistant',content:''},done:true,done_reason:'stop',prompt_eval_count:900,eval_count:40}]);
  };
  const ollama=createOllama('http://localhost:11434/v1/',{fetch,apiKey:''});
  assert.deepEqual(await ollama.status!(),{running:true,version:'0.13.2'});
  assert.deepEqual((await ollama.models!()).map(m=>[m.id,m.label,m.description]),[['old-model:7b','old-model:7b',undefined],['qwen3:latest','qwen3','8.2B · Q4_K_M']]);
  const text:string[]=[];
  const turn=await ollama.chat({model:'qwen3:latest',tools:request.tools,toolChoice:'auto',messages:[{role:'system',content:'rules'},{role:'user',content:'invoice?'},
    {role:'assistant',content:null,tool_calls:[{id:'a',type:'function',function:{name:'read_thread',arguments:'{"ref":"m1"}'}}]},{role:'tool',tool_call_id:'a',name:'read_thread',content:'{"subject":"x"}'}]},{onText:t=>text.push(t)});
  assert.deepEqual(text,['Looking','.']);assert.equal(turn.content,'Looking.');
  assert.deepEqual(turn.toolCalls,[{id:'call_0',name:'search_mail',arguments:'{"query":"invoice"}'}]);assert.deepEqual(turn.usage,{prompt:900,completion:40});
  const chat=seen.find(s=>s.url==='http://localhost:11434/api/chat')!.body;
  assert.equal(chat.options.num_ctx,16384);assert.equal(chat.think,false);assert.equal(chat.stream,true);assert.equal(chat.tools[0].function.name,'search_mail');
  assert.deepEqual(chat.messages[2],{role:'assistant',content:'',tool_calls:[{function:{name:'read_thread',arguments:{ref:'m1'}}}]});
  assert.deepEqual(chat.messages[3],{role:'tool',tool_name:'read_thread',content:'{"subject":"x"}'});
  await ollama.chat({model:'qwen3:latest',tools:request.tools,toolChoice:'none',messages:[{role:'user',content:'q'}]},{});
  assert.equal(seen.filter(s=>s.url.endsWith('/api/chat')).at(-1)!.body.tools,undefined,'the final step sends no tools');
  await assert.rejects(ollama.chat({model:'missing',messages:[{role:'user',content:'q'}]},{}),/ollama pull/);
  const down=createOllama('http://localhost:11434',{fetch:async()=>{throw new TypeError('fetch failed');}});
  assert.deepEqual(await down.status!(),{running:false});
  await assert.rejects(down.chat({model:'qwen3',messages:[{role:'user',content:'q'}]},{}),/Ollama isn’t running at localhost:11434/);
});

test('LM Studio: OpenAI-compatible chat, tool-trained models from its REST API, and an older-version fallback',async()=>{
  const seen:{url:string;headers:Record<string,string>}[]=[];let v1=true;
  const fetch:typeof globalThis.fetch=async(input,init)=>{
    const url=String(input);seen.push({url,headers:{...(init?.headers as Record<string,string>)}});
    if(url.endsWith('/api/v1/models'))return v1?new Response(JSON.stringify({models:[
      {key:'qwen/qwen3-8b',display_name:'Qwen3 8B',type:'llm',params_string:'8B',quantization:{name:'Q4_K_M'},loaded_instances:[{id:'x'}],capabilities:{vision:false,trained_for_tool_use:true}},
      {key:'some/base-model',display_name:'Base',type:'llm',loaded_instances:[],capabilities:{vision:false,trained_for_tool_use:false}},
      {key:'nomic-embed',type:'embedding',loaded_instances:[]}]})):new Response('not found',{status:404});
    if(url.endsWith('/v1/models'))return new Response(JSON.stringify({data:[{id:'qwen/qwen3-8b'},{id:'text-embedding-nomic'}]}));
    return sse([data({choices:[{delta:{content:'Hi'}}]})]);
  };
  const studio=createLmStudio('http://localhost:1234',{fetch,apiKey:''});
  assert.deepEqual(await studio.status!(),{running:true});
  assert.deepEqual(await studio.models!(),[{id:'qwen/qwen3-8b',label:'Qwen3 8B',description:'8B · Q4_K_M · loaded'}]);
  v1=false;assert.deepEqual((await studio.models!()).map(m=>m.id),['qwen/qwen3-8b']);
  assert.equal((await studio.chat({...request,model:'qwen/qwen3-8b'},{})).content,'Hi');
  const chat=seen.find(s=>s.url.endsWith('/chat/completions'))!;
  assert.equal(chat.url,'http://localhost:1234/v1/chat/completions');assert.equal(chat.headers.Authorization,undefined,'auth is off by default');
  const down=createLmStudio('http://localhost:1234',{fetch:async()=>{throw new TypeError('fetch failed');}});
  assert.deepEqual(await down.status!(),{running:false});
  await assert.rejects(down.chat({...request,model:'x'},{}),/LM Studio isn’t answering at localhost:1234/);
});

test('local servers default to their usual ports and report whether they are running',async()=>{
  const dataDir=await mkdtemp(join(tmpdir(),'aplos-local-'));const used:string[]=[];
  const service=await createService({dataDir,google:await createGoogle({dataDir,clientId:''}),groq:createGroq({apiKey:''}),
    serverChat:(id,url)=>{used.push(`${id} ${url}`);return {available:true,chat:async()=>({content:'ok',toolCalls:[]}),status:async()=>({running:id==='ollama',...(id==='ollama'?{version:'0.13.2'}:{})}),models:async()=>id==='ollama'?[{id:'qwen3:latest',label:'qwen3'}]:[]};}});
  try{
    type Entry={id:string;available:boolean;running?:boolean;address?:string;defaultAddress?:string;version?:string;models:{id:string}[]};
    const catalog=await service.invoke('ai.models') as Entry[];
    const ollama=catalog.find(p=>p.id==='ollama')!,studio=catalog.find(p=>p.id==='lmstudio')!;
    assert.deepEqual([ollama.running,ollama.available,ollama.address,ollama.version,ollama.models.map(m=>m.id)],[true,true,'http://localhost:11434','0.13.2',['qwen3:latest']]);
    assert.deepEqual([studio.running,studio.available,studio.address],[false,false,'http://localhost:1234']);
    await service.invoke('settings.update',{patch:{askOllamaUrl:'http://studio-mac.local:11434'}});
    await service.invoke('settings.update',{patch:{askModel:'ollama:qwen3:latest'}});
    assert.equal((await service.invoke('state.get') as AppState).settings.askModel,'ollama:qwen3:latest');
    await service.invoke('ai.ask',{message:'Hi'});
    assert.ok(used.includes('ollama http://studio-mac.local:11434'));
    await assert.rejects(service.invoke('settings.update',{patch:{askLmStudioUrl:'ftp://x'}}),/http or https/);
  }finally{await service.close();await rm(dataDir,{recursive:true,force:true});}
});

test('summaries, drafts, plans and voice each run on the model chosen for them',async()=>{
  const dataDir=await mkdtemp(join(tmpdir(),'aplos-features-'));
  const asked:ChatRequest[]=[],heard:string[]=[];
  // Claude has no JSON mode, so its reply may wrap the object in prose; the writer still reads it.
  const claude:ChatProvider={available:true,chat:async req=>{asked.push(req);return {content:String(req.messages[0].content).includes('Proofread')?'{"html":"<p>Polished.</p>"}':'Here it is: {"summary":"Wants a layout pick by Friday","importance":"important","replyStatus":"needs-reply"}',toolCalls:[]};}};
  const openai:ChatProvider={available:true,chat:claude.chat,transcribe:async(_audio,_type,model)=>{heard.push(model);return {text:'Hello there'};}};
  const groq={...createGroq({apiKey:''}),available:true,summarize:async()=>{throw new Error('Summaries must not use Groq here.');}};
  const service=await createService({dataDir,google:await createGoogle({dataDir,clientId:''}),groq,chats:{anthropic:claude,openai,gemini:{available:false,chat:claude.chat}}});
  try{
    const settings=(await service.invoke('state.get') as AppState).settings;
    assert.deepEqual([settings.summaryModel,settings.draftModel,settings.planModel,settings.voiceModel],['groq:openai/gpt-oss-120b','groq:openai/gpt-oss-120b','groq:openai/gpt-oss-120b','groq:whisper-large-v3-turbo']);
    await service.invoke('settings.update',{patch:{summaryModel:'anthropic:claude-haiku-5-5',draftModel:'anthropic:claude-sonnet-5-5',voiceModel:'openai:gpt-4o-mini-transcribe'}});
    const threadId=(await service.invoke('state.get') as AppState).threads[0].id;
    assert.equal((await service.invoke('ai.summarize',{threadId}) as {summary:string}).summary,'Wants a layout pick by Friday');
    assert.equal(asked[0].model,'claude-haiku-5-5');assert.equal(asked[0].json,true);assert.equal(asked[0].tools,undefined);
    assert.deepEqual(await service.invoke('ai.polish',{html:'<p>polish me</p>'}),{html:'<p>Polished.</p>'});
    assert.equal(asked[1].model,'claude-sonnet-5-5');
    assert.deepEqual(await service.invoke('ai.transcribe',{audio:'AAAA',mimeType:'audio/webm'}),{text:'Hello there'});
    assert.deepEqual(heard,['gpt-4o-mini-transcribe']);
    // Voice needs a provider with speech to text; a provider without its key says what to set.
    await assert.rejects(service.invoke('settings.update',{patch:{voiceModel:'anthropic:claude-haiku-5-5'}}),/Voice model on Groq or ChatGPT/);
    await service.invoke('settings.update',{patch:{planModel:'gemini:gemini-3.8-flash'}});
    await assert.rejects(service.invoke('calendar.extract',{threadId}),/Add GEMINI_API_KEY/);
    const catalog=await service.invoke('ai.models') as Array<{id:string;voiceModels?:{id:string}[]}>;
    assert.deepEqual(catalog.filter(p=>p.voiceModels).map(p=>p.id),['groq','openai']);
  }finally{await service.close();await rm(dataDir,{recursive:true,force:true});}
});

test('OpenAI transcribes with the chosen model and lists its speech models; JSON requests turn on JSON mode',async()=>{
  const openai=recorder(url=>url.endsWith('/models')?new Response(JSON.stringify({data:[{id:'gpt-6-luna'},{id:'gpt-4o-mini-transcribe'},{id:'whisper-1'},{id:'gpt-4o-transcribe-diarize'},{id:'gpt-realtime-transcribe'}]})):url.endsWith('/audio/transcriptions')?new Response(JSON.stringify({text:'hi'})):sse([data({choices:[{delta:{content:'{}'}}]})]));
  const gpt=createOpenAI({apiKey:'oa',fetch:openai.fetch});
  assert.deepEqual((await gpt.voiceModels!()).map(m=>m.id),['gpt-4o-mini-transcribe','whisper-1']);
  assert.deepEqual((await gpt.models!()).map(m=>m.id),['gpt-6-luna']);
  const fetchCalls:{url:string;model:FormDataEntryValue|null}[]=[];
  const voice=createOpenAI({apiKey:'oa',fetch:async(input,init)=>{fetchCalls.push({url:String(input),model:(init?.body as FormData).get('model')});return new Response(JSON.stringify({text:'hi'}));}});
  assert.deepEqual(await voice.transcribe!('AAAA','audio/webm','whisper-1'),{text:'hi'});
  assert.deepEqual(fetchCalls,[{url:'https://api.openai.com/v1/audio/transcriptions',model:'whisper-1'}]);
  await gpt.chat({model:'gpt-6-luna',json:true,messages:[{role:'user',content:'hi'}]},{});
  assert.deepEqual(openai.seen.at(-1)!.body!.response_format,{type:'json_object'});
});
