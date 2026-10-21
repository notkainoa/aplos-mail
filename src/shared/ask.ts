/** Groq models verified to call tools reliably for Ask (live check, 2026-10-21). Groq is the only provider. */
export const askModels=[
  {id:'openai/gpt-oss-120b',label:'GPT-OSS 120B',description:'Most careful with search, dates and drafts.'},
  {id:'openai/gpt-oss-20b',label:'GPT-OSS 20B',description:'Fastest, but slips more often on dates and contacts. Review its cards closely.'},
  {id:'qwen/qwen3.8-27b',label:'Qwen3.8 27B',description:'Careful and accurate in testing. A Groq preview model that may change without notice.'},
] as const;
export const defaultAskModel='openai/gpt-oss-120b';
export const askModelIds:readonly string[]=askModels.map(m=>m.id);
