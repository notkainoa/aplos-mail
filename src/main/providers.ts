import type { ChatProvider } from '../engine/ports';
import type { AskModelInfo } from '../shared/ask';
import { askProvider } from '../shared/ask';
import { providerRequest, streamChat, type ProviderTarget } from './llm';

/** Ask's other providers. Both speak OpenAI-compatible chat/completions with streamed tool calls. */
export interface ProviderOptions { apiKey?:string; fetch?:typeof fetch; version?:string }

/** Model lists change rarely; refresh at most hourly and fall back to the curated list offline. */
function cached(load:(signal?:AbortSignal)=>Promise<AskModelInfo[]>,ttl=60*60_000){
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
