/**
 * Settings → AI setup notices (DESIGN 9 rule 7): the quiet lines that say why a feature cannot answer. A provider that
 * needs a key says so once for every feature behind it, with Add key; red is kept for a key that was refused.
 */
import type { AiProvider, Settings } from '../../data';
import type { AiFeature } from '../../ui/props';
import {
  AI_FEATURES,
  byId,
  featureLabel,
  joinWords,
  providerName,
  usableFor,
} from './settings.model';

export interface AiNotice {
  readonly id: string;
  readonly text: string;
  /** The provider whose key the notice asks for: the notice then offers "Add key" for it. */
  readonly addKeyFor?: string;
  /** The features the notice speaks for, for a reader of the notice. */
  readonly features?: readonly AiFeature[];
}

/** One feature whose chosen provider cannot answer, and why. */
interface Blocked {
  readonly feature: AiFeature;
  readonly provider: string;
  readonly learns: boolean;
}

function blockedFeatures(
  settings: Pick<Settings, 'ai'>,
  providers: readonly AiProvider[],
): Blocked[] {
  const out: Blocked[] = [];
  for (const feature of AI_FEATURES) {
    const choice = settings.ai.features[feature];
    const p = byId(providers, choice.provider);
    if (!p || usableFor(p, feature)) continue;
    out.push({
      feature,
      provider: choice.provider,
      learns: feature !== 'voice' && p.trainsOnInputs === true,
    });
  }
  return out;
}

/** "Ask, Summaries and Voice use Groq, which needs a key." One sentence for every feature behind the same provider. */
function keyNotice(provider: string, group: readonly Blocked[]): AiNotice {
  const labels = group.map(b => featureLabel(b.feature));
  const verb = group.length === 1 ? 'uses' : 'use';
  return {
    id: `key-${provider}`,
    text: `${joinWords(labels)} ${verb} ${providerName(provider)}, which needs a key.`,
    addKeyFor: provider,
    features: group.map(b => b.feature),
  };
}

function learnsNotice(blocked: Blocked): AiNotice {
  const name = providerName(blocked.provider);
  const label = featureLabel(blocked.feature);
  return {
    id: `feature-${blocked.feature}`,
    text: `${name} may learn from what it’s sent, so Aplos doesn’t send it your mail. Pick another provider for ${label}.`,
    features: [blocked.feature],
  };
}

/**
 * The quiet lines when nothing can answer (DESIGN 9 rule 7): one when no provider is set up, else one per provider that
 * blocks features (a provider that needs a key says so once for all of them), and one for a provider that learns from
 * what it is sent.
 */
export function aiNotices(
  settings: Pick<Settings, 'ai'>,
  providers: readonly AiProvider[],
): readonly AiNotice[] {
  const anyReady = providers.some(p => p.status === 'ready' && p.running !== false);
  if (!anyReady) {
    return [
      {
        id: 'noProvider',
        text: 'No AI provider is set up. Mail shows its subjects and nothing is sent. Add a key below to turn on summaries, drafts and Ask.',
      },
    ];
  }
  const blocked = blockedFeatures(settings, providers);
  const needKey = new Map<string, Blocked[]>();
  for (const item of blocked.filter(b => !b.learns)) {
    needKey.set(item.provider, [...(needKey.get(item.provider) ?? []), item]);
  }
  const keys = [...needKey].map(([provider, group]) => keyNotice(provider, group));
  return [...keys, ...blocked.filter(b => b.learns).map(learnsNotice)];
}
