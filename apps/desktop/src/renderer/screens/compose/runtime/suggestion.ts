/**
 * The dim suggestion's text (DESIGN 9 rule 6, 7.2 Follow up): the follow-up nudge the background job wrote
 * (`Ai/followup`), or a draft written on request (`Ai/draft`). With AI off, no consent, or a provider error the answer
 * is null and nothing shows: absence is quiet, with no placeholder about AI.
 */
import type { DataApi } from '../../../data';
import type { ComposeSuggestion } from '../model/composeState';
import { htmlToText } from '../model/fields';

export type SuggestionRequest =
  { readonly kind: 'followUp' } | { readonly kind: 'draft'; readonly instruction: string };

export async function loadSuggestion(
  ai: Pick<DataApi['ai'], 'followup' | 'draft'>,
  threadId: string,
  request: SuggestionRequest,
): Promise<ComposeSuggestion | null> {
  try {
    if (request.kind === 'followUp') {
      const { suggestion } = await ai.followup({ threadId });
      return suggestion ? { kind: 'followUp', text: htmlToText(suggestion.html) } : null;
    }
    const { html } = await ai.draft({ instruction: request.instruction, threadId });
    const text = htmlToText(html);
    return text.trim() ? { kind: 'draft', text } : null;
  } catch {
    return null;
  }
}
