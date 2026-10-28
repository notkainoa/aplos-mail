import { aiFeature, askProvider, parseFeatureModel } from '@aplos/contract/legacy/ask';
export { hasRealSummary } from '@aplos/contract/legacy/summary';

/** The provider writing summaries (Settings → AI), named the way its errors name it. */
export type SummaryProvider = { label: string; env: string; keyOptional?: boolean };
export function summaryProvider(summaryModel: string | undefined): SummaryProvider {
  const ref =
    parseFeatureModel('summary', summaryModel) ??
    parseFeatureModel('summary', aiFeature('summary').fallback)!;
  const { label, env, keyOptional } = askProvider(ref.provider);
  return { label, env, keyOptional };
}

export type SummaryProblem = { title: string; detail: string };
const another = 'or choose another model for Summaries in Settings → AI';
/** Turns an engine error into a short reason for the card and an explanation for its details popover. */
export function describeSummaryError(
  message: string,
  { label: name, env }: SummaryProvider,
): SummaryProblem {
  const m = message.toLowerCase();
  if (m.includes('in settings → ai to use'))
    return {
      title: `${name} isn’t set up`,
      detail: `Summaries use ${name}, but no ${name} key is set. Add one in Settings → AI, ${another}.`,
    };
  if (m.includes('rejected the api key') || m.includes('rejected the request'))
    return {
      title: `${name} didn’t accept the API key`,
      detail: `The ${name} key Aplos is using was refused. It may be mistyped, revoked or expired. Replace it in Settings → AI, ${another}.`,
    };
  if (m.includes('usage limit'))
    return {
      title: `${name}’s usage limit is reached`,
      detail: `This ${name} account has used its allowance for now. Summaries will work again once the limit resets, ${another}.`,
    };
  if (m.includes('rate limit') || m.includes('is busy') || m.includes('overloaded'))
    return {
      title: `${name} is busy right now`,
      detail: `${name} is limiting how many requests Aplos can make at once, often while new mail is being summarized. Wait a moment and retry.`,
    };
  if (m.includes('no credits'))
    return {
      title: `${name} has no credits left`,
      detail: `The ${name} account Aplos uses is out of credits. Add credits and retry, ${another}.`,
    };
  if (m.includes('too large') || m.includes('too much text'))
    return {
      title: 'This email is too long to summarize',
      detail: `The thread is bigger than what ${name} accepts in one request on this plan. Retry later, ${another}.`,
    };
  if (m.includes('isn’t running') || m.includes('isn’t answering'))
    return {
      title: `${name} isn’t running`,
      detail: `Aplos couldn’t reach ${name} at its address. Open it, or change its address in Settings → AI.`,
    };
  if (m.includes('check your connection'))
    return {
      title: `Couldn’t reach ${name}`,
      detail: `Aplos couldn’t connect to ${name}. Check your internet connection and retry.`,
    };
  if (m.includes('declined'))
    return {
      title: `${name} declined to summarize this`,
      detail: `The model refused this email. Retry, ${another}.`,
    };
  if (
    m.includes('invalid response') ||
    m.includes('empty summary') ||
    m.includes('stopped while answering')
  )
    return {
      title: `${name}’s answer was unusable`,
      detail: `${name} replied, but not with a summary Aplos could use. This is usually a one-off, so retrying normally works.`,
    };
  if (m.includes('cancelled'))
    return { title: 'Summary cancelled', detail: `The request stopped before ${name} answered.` };
  if (m.includes('not available') || m.includes('doesn’t have this model'))
    return {
      title: 'The summary model is unavailable',
      detail: `The ${name} model chosen for Summaries isn’t available right now. Try again later, ${another}.`,
    };
  return { title: 'Something went wrong', detail: `${name} couldn’t summarize this email.` };
}
