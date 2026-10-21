import type { ChatProvider } from '../engine/ports';
import type { AskModelInfo, AskProviderId } from '../shared/ask';
import { askProvider } from '../shared/ask';
import { providerRequest, streamChat, type ProviderTarget, type StreamOptions } from './llm';

/** Ask's other providers. Both speak OpenAI-compatible chat/completions with streamed tool calls. */
export interface ProviderOptions { apiKey?:string; fetch?:typeof fetch; version?:string }

/** Model lists change rarely; refresh at most hourly and fall back to the curated list offline. */
function cached(load:(signal?:AbortSignal)=>Promise<AskModelInfo[]>,ttl=60*60_000){
  // A failed load is not cached, so the next open tries again.
  let value:{at:number;models:AskModelInfo[]}|undefined;
  return async(signal?:AbortSignal)=>{
    if(value&&Date.now()-value.at<ttl)return value.models;
    const models=await load(signal);value={at:Date.now(),models};return models;
  };
}
const perMillion=(price:unknown)=>{const n=Number(price)*1e6;return Number.isFinite(n)?(n<1?n.toFixed(2):n.toFixed(n<10?1:0)).replace(/\.0+$/,''):'';};

export function createOpenRouter(options:ProviderOptions={}):ChatProvider {
  const apiKey=options.apiKey??process.env.OPENROUTER_API_KEY,request=options.fetch??fetch;
  // Attribution headers are optional; they name the app on OpenRouter's side and carry no user data.
  const target:ProviderTarget={name:'OpenRouter',env:'OPENROUTER_API_KEY',baseUrl:'https://openrouter.ai/api/v1',apiKey,fetch:request,headers:{'X-OpenRouter-Title':'Aplos Mail'}};
  const curated=askProvider('openrouter').models;
  return {
    available:!!apiKey,
    chat:streamChat((path,body,signal,headers)=>providerRequest(target,path,body,signal,true,'POST',headers),{name:'OpenRouter',maxTokens:4096}),
    // The public catalog; only models that accept tools can run Ask.
    models:cached(async signal=>{
      const response=await request('https://openrouter.ai/api/v1/models',{signal:AbortSignal.any([AbortSignal.timeout(15_000),...(signal?[signal]:[])])});
      if(!response.ok)throw new Error('OpenRouter models are unavailable.');
      const data=(await response.json() as {data?:Array<{id?:unknown;name?:unknown;supported_parameters?:unknown;pricing?:{prompt?:unknown;completion?:unknown}}>}).data??[];
      const live=data.filter(m=>typeof m.id==='string'&&Array.isArray(m.supported_parameters)&&m.supported_parameters.includes('tools')).map((m):AskModelInfo=>{
        const known=curated.find(c=>c.id===m.id),price=perMillion(m.pricing?.prompt),out=perMillion(m.pricing?.completion);
        return {id:String(m.id),label:known?.label??String(m.name??m.id).replace(/^[^:]+:\s*/,''),description:known?.description??(price&&out?`$${price} in · $${out} out per million tokens`:undefined)};
      });
      return [...curated.filter(c=>live.some(m=>m.id===c.id)).map(c=>live.find(m=>m.id===c.id)!),...live.filter(m=>!curated.some(c=>c.id===m.id)).sort((a,b)=>a.id.localeCompare(b.id))];
    }),
  };
}

export function createOpenCodeGo(options:ProviderOptions={}):ChatProvider {
  const apiKey=options.apiKey??process.env.OPENCODE_API_KEY,request=options.fetch??fetch;
  // OpenCode asks Go clients to name themselves and send a stable session ID per conversation (routing and caching).
  const target:ProviderTarget={name:'OpenCode Go',env:'OPENCODE_API_KEY',baseUrl:'https://opencode.ai/inference/go/openai/v1',apiKey,fetch:request,headers:{'User-Agent':`aplos-mail/${options.version??'0.1.0'}`}};
  const curated=askProvider('opencode-go').models;
  return {
    available:!!apiKey,
    chat:streamChat((path,body,signal,headers)=>providerRequest(target,path,body,signal,true,'POST',headers),{name:'OpenCode Go',maxTokens:4096,headers:(request):Record<string,string>=>request.session?{'x-opencode-session':request.session}:{}}),
    // Go's catalog also lists models that need other APIs, so only the chat/completions ones it still offers are shown.
    models:cached(async signal=>{
      const response=await request('https://opencode.ai/inference/go/v1/models',{headers:{'User-Agent':target.headers!['User-Agent']},signal:AbortSignal.any([AbortSignal.timeout(15_000),...(signal?[signal]:[])])});
      if(!response.ok)throw new Error('OpenCode Go models are unavailable.');
      const ids=new Set(((await response.json() as {data?:Array<{id?:unknown}>}).data??[]).map(m=>m.id));
      return curated.filter(m=>ids.has(m.id));
    }),
  };
}

/**
 * A provider whose chat/completions speaks the OpenAI dialect, with its model list from GET /models.
 * `keep` picks the chat models out of that list; curated ones come first with their descriptions.
 */
function compatible(target:ProviderTarget&{fetch:typeof fetch},id:AskProviderId,{keep=()=>true,stream={}}:{keep?:(id:string)=>boolean;stream?:Omit<StreamOptions,'name'>}={}):ChatProvider {
  const curated=askProvider(id).models;
  return {
    available:!!target.apiKey||!!target.keyOptional,
    chat:streamChat((path,body,signal,headers)=>providerRequest(target,path,body,signal,true,'POST',headers),{name:target.name,maxTokens:4096,...stream}),
    models:cached(async signal=>{
      const response=await providerRequest(target,'models',undefined,signal,false,'GET');
      const ids=((await response.json() as {data?:Array<{id?:unknown}>}).data??[]).map(m=>String(m.id??'').replace(/^models\//,'')).filter(m=>m&&keep(m));
      return [...curated.filter(c=>ids.includes(c.id)),...ids.filter(m=>!curated.some(c=>c.id===m)).sort().map(m=>({id:m,label:m}))];
    },10*60_000),
  };
}

/** ChatGPT models through the OpenAI API. Its reasoning models reject a temperature, so none is sent. */
export function createOpenAI(options:ProviderOptions={}):ChatProvider {
  const request=options.fetch??fetch;
  return compatible({name:'OpenAI',env:'OPENAI_API_KEY',baseUrl:'https://api.openai.com/v1',apiKey:options.apiKey??process.env.OPENAI_API_KEY,fetch:request},'openai',{
    keep:id=>/^(gpt-|o\d|chatgpt-)/.test(id)&&!/(audio|realtime|image|tts|transcribe|search|embedding|moderation|instruct)/.test(id),
    stream:{temperature:null,extra:()=>({reasoning_effort:'low'})},
  });
}

/** Gemini through Google's OpenAI-compatible endpoint, which takes the API key as a bearer token. */
export function createGemini(options:ProviderOptions={}):ChatProvider {
  const request=options.fetch??fetch;
  return compatible({name:'Gemini',env:'GEMINI_API_KEY',baseUrl:'https://generativelanguage.googleapis.com/v1beta/openai',apiKey:options.apiKey??process.env.GEMINI_API_KEY,fetch:request},'gemini',{
    keep:id=>/^gemini-/.test(id)&&!/(embedding|image|tts|live|audio)/.test(id),
    stream:{extra:()=>({reasoning_effort:'low'})},
  });
}

/** Any OpenAI-compatible server at an address the owner chose in Settings (Ollama, LM Studio, vLLM…). */
export function createCustom(baseUrl:string,options:ProviderOptions={}):ChatProvider {
  const request=options.fetch??fetch;
  return compatible({name:'Your AI server',env:'CUSTOM_AI_API_KEY',baseUrl:baseUrl.replace(/\/+$/,''),apiKey:options.apiKey??process.env.CUSTOM_AI_API_KEY,keyOptional:true,fetch:request},'custom');
}
