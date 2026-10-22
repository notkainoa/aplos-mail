export {hasRealSummary} from '../shared/summary';

export type SummaryProblem={title:string;detail:string};
/** Turns an engine error into a short reason for the card and an explanation for its details popover. */
export function describeSummaryError(message:string):SummaryProblem{
  const m=message.toLowerCase();
  if(m.includes('set groq_api_key'))return {title:'Groq isn’t set up',detail:'Aplos writes summaries with Groq, but it didn’t find a GROQ_API_KEY when it started. Add the key to the app’s environment and restart Aplos.'};
  if(m.includes('rejected the api key'))return {title:'Groq didn’t accept the API key',detail:'The GROQ_API_KEY Aplos is using was refused. It may be mistyped, revoked or expired. Replace it and restart Aplos.'};
  if(m.includes('usage limit'))return {title:'Groq’s usage limit is reached',detail:'This Groq account has used its allowance for now. Summaries will work again once the limit resets.'};
  if(m.includes('rate limit'))return {title:'Groq is busy right now',detail:'Groq is limiting how many requests Aplos can make at once, often while new mail is being summarized. Wait a moment and retry.'};
  if(m.includes('no credits'))return {title:'Groq has no credits left',detail:'The Groq account behind GROQ_API_KEY is out of credits. Add credits and retry.'};
  if(m.includes('check your connection'))return {title:'Couldn’t reach Groq',detail:'Aplos couldn’t connect to Groq. Check your internet connection and retry.'};
  if(m.includes('invalid response')||m.includes('empty summary'))return {title:'Groq’s answer was unusable',detail:'Groq replied, but not with a summary Aplos could use. This is usually a one-off, so retrying normally works.'};
  if(m.includes('too large'))return {title:'This email is too long to summarize',detail:'The thread is bigger than what Aplos sends to Groq in one request.'};
  if(m.includes('cancelled'))return {title:'Summary cancelled',detail:'The request stopped before Groq answered.'};
  if(m.includes('not available'))return {title:'Groq’s model is unavailable',detail:'The Groq model Aplos uses for summaries isn’t available right now. Try again later.'};
  return {title:'Something went wrong',detail:'Groq couldn’t summarize this email.'};
}
