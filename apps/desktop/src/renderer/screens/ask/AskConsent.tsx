/**
 * The AI consent line (plan 30 U7; `useConsent`, `Consent/grant`): shown before Ask's first use when the consent
 * record is missing, ungranted or stale (`needsReconsent`), naming the provider and model Ask will use. Allow grants
 * the shown version; "Not now" records nothing and hides the line until the next version bump. One plain sentence —
 * the privacy explanation itself lives in Settings → AI (DESIGN §10).
 */
import { Button } from '../../ui/buttons-keys';
import { Text } from '../../ui/surfaces';

export interface ConsentLineProps {
  /** Provider display name, e.g. "Groq". */
  readonly provider: string;
  /** Model id, e.g. "llama-3.3-70b-versatile". */
  readonly model: string;
  /** Local providers keep mail on this Mac (FR-5). */
  readonly local: boolean;
  readonly onAllow: () => void;
  readonly onNotNow: () => void;
}

export function ConsentLine({ provider, model, local, onAllow, onNotNow }: ConsentLineProps) {
  const where = local ? 'on this Mac.' : 'Your question and the mail it reads go to that provider.';
  return (
    <div className="ask-screen__consent" role="note">
      <Text variant="small" tone="dim">
        {`Ask answers with ${provider} · ${model}. ${where}`}
      </Text>
      <div className="ask-screen__consent-acts">
        <Button variant="filled" size="md" label="Allow" onPress={onAllow} />
        <Button variant="text" size="md" label="Not now" onPress={onNotNow} />
      </div>
    </div>
  );
}
