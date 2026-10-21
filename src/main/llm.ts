import type { Chat, ChatRequest, ChatTurn } from '../engine/agent';

/**
 * OpenAI-compatible chat transports for Ask (Groq, OpenRouter, OpenCode Go). Keys come only from the backend
 * environment and never reach the renderer. Errors never carry provider response bodies, only a known code.
 */
export interface ProviderTarget { name:string; env:string; baseUrl:string; apiKey?:string; fetch?:typeof fetch; headers?:Record<string,string> }

export async function providerRequest(target:ProviderTarget,path:string,body:BodyInit|undefined,signal?:AbortSignal,json=true,method='POST',headers:Record<string,string>={}):Promise<Response> {
  const {name,env}=target;
  if(!target.apiKey) throw new Error(`Set ${env} in the main process to use ${name}.`);
  let response:Response;
  try {
    response=await (target.fetch??fetch)(`${target.baseUrl}/${path}`,{method,headers:{Authorization:`Bearer ${target.apiKey}`,...(json?{'Content-Type':'application/json'}:{}),...target.headers,...headers},...(method==='GET'?{}:{body}),signal:AbortSignal.any([AbortSignal.timeout(90000),...(signal?[signal]:[])])});
  } catch {
    if(signal?.aborted) throw new Error('AI request cancelled.');
    throw new Error(`${name} could not complete the request. Check your connection and try again.`);
  }
  if(response.ok) return response;
  if(response.status===401||response.status===403) throw new Error(`${name} rejected the API key. Check ${env}.`);
  if(response.status===402) throw new Error(`${name} has no credits left on this account. Add credits or choose another Ask model in Settings.`);
  if(response.status===429) {
    // Ask waits out a short limit window; other callers just report it. A long wait means a daily or plan quota.
    const seconds=Number(response.headers.get('retry-after'));
    const message=Number.isFinite(seconds)&&seconds>90?`${name}’s usage limit for this model is reached. Try again in about ${Math.ceil(seconds/60)} minutes, or choose another Ask model in Settings.`:`${name} rate limit reached. Please try again shortly.`;
    throw Object.assign(new Error(message),{code:'rate_limited',...(Number.isFinite(seconds)&&seconds>=0?{retryAfterMs:seconds*1000}:{})});
  }
  const code=await response.json().then(value=>(value as {error?:{code?:unknown}})?.error?.code,()=>undefined);
  if(code==='tool_use_failed') throw Object.assign(new Error(`${name} could not read a tool call. Please try again.`),{code});
  if(code==='model_not_found'||code==='model_decommissioned'||response.status===404) throw new Error(`This ${name} model is not available right now. Choose another Ask model in Settings.`);
  throw new Error(`${name} request failed (${response.status}). Please try again.`);
}

export interface StreamOptions {
  /** Shown in errors, e.g. "Groq". */
  name?:string;
  /** Provider-specific body fields such as reasoning effort. */
  extra?:(request:ChatRequest)=>Record<string,unknown>;
  /** Per-request headers, e.g. a session ID. */
  headers?:(request:ChatRequest)=>Record<string,string>;
  maxTokens?:number;
}
type Send=(path:string,body:BodyInit,signal?:AbortSignal,headers?:Record<string,string>)=>Promise<Response>;
/** A streamed tool-capable chat/completions call over `send`. */
export function streamChat(send:Send,{name='The AI provider',extra=()=>({}),headers=()=>({}),maxTokens=2048}:StreamOptions={}):Chat {
  return async(chat,{signal,onText}={})=>{
    const body={model:chat.model,messages:chat.messages,stream:true,temperature:0.3,max_completion_tokens:chat.maxTokens??maxTokens,...extra(chat),
      ...(chat.tools?.length?{tools:chat.tools.map(t=>({type:'function',function:t})),tool_choice:chat.toolChoice??'auto'}:{})};
    const response=await send('chat/completions',JSON.stringify(body),signal,headers(chat));
    if(!response.body) throw new Error(`${name} returned an invalid response. Please try again.`);
    try {return await readChatStream(response.body,onText,signal);}
    catch(error) {
      if(signal?.aborted) throw new Error('AI request cancelled.');
      if((error as {code?:unknown}).code) throw error;
      throw new Error(`${name} stopped while answering. Please try again.`);
    }
  };
}

/**
 * Reads an OpenAI-style SSE completion: text deltas go to `onText`; tool calls are assembled by index
 * whether they arrive whole or in fragments. `finish_reason` is not required (Groq sometimes omits it).
 */
export async function readChatStream(body:ReadableStream<Uint8Array>,onText?:(text:string)=>void,signal?:AbortSignal):Promise<ChatTurn> {
  const reader=body.getReader(),decoder=new TextDecoder();
  let buffer='',content='',finishReason:string|undefined,usage:ChatTurn['usage'];
  const calls:{id?:string;name:string;arguments:string}[]=[];
  const line=(raw:string)=>{
    if(!raw.startsWith('data:'))return;
    const data=raw.slice(5).trim();if(!data||data==='[DONE]')return;
    let chunk:Record<string,any>;try{chunk=JSON.parse(data);}catch{return;}
    const error=chunk.error??chunk.x_groq?.error;
    if(error)throw Object.assign(new Error('The AI provider stopped while answering.'),typeof error==='object'&&error?.code==='tool_use_failed'?{code:'tool_use_failed'}:{});
    const counted=chunk.x_groq?.usage??chunk.usage;
    if(counted&&typeof counted.prompt_tokens==='number')usage={prompt:counted.prompt_tokens,completion:Number(counted.completion_tokens)||0};
    const choice=chunk.choices?.[0];if(!choice)return;
    const delta=choice.delta??{};
    if(typeof delta.content==='string'&&delta.content){content+=delta.content;onText?.(delta.content);}
    for(const part of Array.isArray(delta.tool_calls)?delta.tool_calls:[]){
      const index=Number.isInteger(part?.index)?part.index:calls.length;
      const call=calls[index]??={name:'',arguments:''};
      if(typeof part.id==='string')call.id=part.id;
      if(typeof part.function?.name==='string')call.name+=part.function.name;
      if(typeof part.function?.arguments==='string')call.arguments+=part.function.arguments;
    }
    if(typeof choice.finish_reason==='string')finishReason=choice.finish_reason;
  };
  let stop:(()=>void)|undefined;
  const aborted=signal?new Promise<never>((_,reject)=>{stop=()=>reject(new Error('AI request cancelled.'));if(signal.aborted)stop();else signal.addEventListener('abort',stop,{once:true});}):undefined;
  aborted?.catch(()=>{});
  try{
    for(;;){
      const {done,value}=await (aborted?Promise.race([reader.read(),aborted]):reader.read());
      if(done)break;
      buffer+=decoder.decode(value,{stream:true});
      for(let at=buffer.indexOf('\n');at>=0;at=buffer.indexOf('\n')){line(buffer.slice(0,at).replace(/\r$/,''));buffer=buffer.slice(at+1);}
    }
    buffer+=decoder.decode();if(buffer.trim())line(buffer.trim());
  }finally{
    if(stop)signal?.removeEventListener('abort',stop);
    void reader.cancel().catch(()=>{});
  }
  return {content,toolCalls:calls.filter(c=>c&&c.name).map((c,i)=>({id:c.id??`call_${i}`,name:c.name,arguments:c.arguments})),finishReason,...(usage?{usage}:{})};
}
