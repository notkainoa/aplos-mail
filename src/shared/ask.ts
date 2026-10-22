/**
 * Where Ask's model runs. Groq also runs every other AI feature (summaries, polish, transcription); Ask alone can
 * use ChatGPT (OpenAI API), Claude, Gemini, OpenRouter, an OpenCode Go plan, Ollama or LM Studio on this Mac,
 * or a custom OpenAI-compatible server.
 * Keys live only in the backend environment.
 * The setting is stored as `provider:model`, e.g. `groq:openai/gpt-oss-120b` or `openrouter:anthropic/claude-haiku-5.5`.
 */
export type AskProviderId='groq'|'openai'|'anthropic'|'gemini'|'openrouter'|'opencode-go'|'ollama'|'lmstudio'|'custom';
/** Providers that run on a server the owner points at (usually this Mac), with no key needed. */
export type AskServerId='ollama'|'lmstudio'|'custom';
export interface AskModelInfo { id:string; label:string; description?:string }
/** `env` is the backend variable holding the key; a custom server's key is optional, its address is a setting. */
export interface AskProviderInfo { id:AskProviderId; label:string; env:string; description:string; models:readonly AskModelInfo[]; keyOptional?:boolean;
  /** Where a local app listens by default; the owner can change it in Settings. */ defaultAddress?:string }

export const askProviders:readonly AskProviderInfo[]=[
  {id:'groq',label:'Groq',env:'GROQ_API_KEY',description:'Very fast open models. Also runs summaries and transcription.',models:[
    // Verified live for tool use on 2026-10-21.
    {id:'openai/gpt-oss-120b',label:'GPT-OSS 120B',description:'Most careful with search, dates and drafts.'},
    {id:'openai/gpt-oss-20b',label:'GPT-OSS 20B',description:'Fastest, but slips more often on dates and contacts. Review its cards closely.'},
    {id:'qwen/qwen3.8-27b',label:'Qwen3.8 27B',description:'Careful and accurate in testing. A Groq preview model that may change without notice.'},
  ]},
  {id:'openai',label:'ChatGPT',env:'OPENAI_API_KEY',description:'OpenAI’s GPT models through the OpenAI API (billed by OpenAI, separate from a ChatGPT subscription).',models:[
    {id:'gpt-6-luna',label:'GPT-6 Luna',description:'Fast and inexpensive.'},
    {id:'gpt-6.1-sol',label:'GPT-6.1 Sol',description:'OpenAI’s strong general model.'},
    {id:'gpt-6-astra',label:'GPT-6 Astra',description:'Most capable; slower and pricier.'},
  ]},
  {id:'anthropic',label:'Claude',env:'ANTHROPIC_API_KEY',description:'Anthropic’s Claude models through the Claude API.',models:[
    {id:'claude-opus-5-5',label:'Claude Opus 5.5',description:'Anthropic’s most capable everyday model.'},
    {id:'claude-sonnet-5-5',label:'Claude Sonnet 5.5',description:'Fast and capable; a good balance.'},
    {id:'claude-haiku-5-5',label:'Claude Haiku 5.5',description:'Quickest and least expensive.'},
  ]},
  {id:'gemini',label:'Gemini',env:'GEMINI_API_KEY',description:'Google’s Gemini models through the Gemini API.',models:[
    {id:'gemini-3.8-flash',label:'Gemini 3.8 Flash',description:'Fast, with a very long context.'},
    {id:'gemini-4-argon',label:'Gemini 4 Argon',description:'Google’s most capable model.'},
    {id:'gemini-3.5-flash-lite',label:'Gemini 3.5 Flash Lite',description:'Lightest and least expensive.'},
  ]},
  {id:'openrouter',label:'OpenRouter',env:'OPENROUTER_API_KEY',description:'Hundreds of models on one key, billed by OpenRouter per token.',models:[
    {id:'anthropic/claude-haiku-5.5',label:'Claude Haiku 5.5',description:'Quick and dependable with tools.'},
    {id:'anthropic/claude-sonnet-5.5',label:'Claude Sonnet 5.5',description:'Most capable here; slower and pricier.'},
    {id:'google/gemini-3.8-flash',label:'Gemini 3.8 Flash',description:'Fast, with a very long context.'},
    {id:'moonshotai/kimi-k3',label:'Kimi K3'},
    {id:'z-ai/glm-5.3',label:'GLM 5.3'},
    {id:'qwen/qwen3.8-flash',label:'Qwen3.8 Flash'},
    {id:'deepseek/deepseek-v4.1-flash',label:'DeepSeek V4.1 Flash',description:'Very low cost.'},
  ]},
  {id:'opencode-go',label:'OpenCode Go',env:'OPENCODE_API_KEY',description:'Your OpenCode Go plan. OpenCode designs Go for coding agents, so heavy mail use may be throttled.',models:[
    // Only models Go serves through chat/completions; its Anthropic- and Responses-style models need other APIs.
    {id:'kimi-k3',label:'Kimi K3'},
    {id:'glm-5.3',label:'GLM 5.3'},
    {id:'glm-5.3-flash',label:'GLM 5.3 Flash',description:'Fast and light on the plan’s limits.'},
    {id:'deepseek-v4-pro',label:'DeepSeek V4 Pro'},
    {id:'deepseek-v4.1-flash',label:'DeepSeek V4.1 Flash',description:'Fast and light on the plan’s limits.'},
  ]},
  {id:'ollama',label:'Ollama',env:'OLLAMA_API_KEY',keyOptional:true,defaultAddress:'http://localhost:11434',description:'Models running on this Mac with Ollama. Mail stays on your machine.',models:[]},
  {id:'lmstudio',label:'LM Studio',env:'LM_STUDIO_API_KEY',keyOptional:true,defaultAddress:'http://localhost:1234',description:'Models running on this Mac with LM Studio. Mail stays on your machine.',models:[]},
  {id:'custom',label:'Custom',env:'CUSTOM_AI_API_KEY',keyOptional:true,description:'Any OpenAI-compatible server, such as Ollama, LM Studio or vLLM. Its model must support tool calling.',models:[]},
];
export const defaultAskModel='groq:openai/gpt-oss-120b';
const modelId=/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;

/** `provider:model`; a bare Groq model ID from earlier builds still reads as Groq. */
export function parseAskModel(value:unknown):{provider:AskProviderId;model:string}|undefined {
  if(typeof value!=='string')return;
  const at=value.indexOf(':'),head=at>0?value.slice(0,at):'';
  const provider=askProviders.find(p=>p.id===head)?.id;
  const model=provider?value.slice(at+1):value;
  if(!modelId.test(model))return;
  if(!provider)return askProviders[0].models.some(m=>m.id===model)?{provider:'groq',model}:undefined;
  return {provider,model};
}
export const askProvider=(id:AskProviderId)=>askProviders.find(p=>p.id===id)!;
export const isAskServer=(id:AskProviderId):id is AskServerId=>id==='ollama'||id==='lmstudio'||id==='custom';
/** The setting holding each server's address; empty means the app's default address. */
export const askServerSetting={ollama:'askOllamaUrl',lmstudio:'askLmStudioUrl',custom:'askCustomUrl'} as const;
/** "Groq · GPT-OSS 120B", or the raw ID for a model outside the curated list. */
export function askModelLabel(value:string){
  const ref=parseAskModel(value)??parseAskModel(defaultAskModel)!;const provider=askProvider(ref.provider);
  return {provider:provider.label,model:provider.models.find(m=>m.id===ref.model)?.label??ref.model};
}
