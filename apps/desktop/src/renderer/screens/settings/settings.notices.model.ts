/**
 * Settings → AI setup notices (DESIGN 9 rule 7): the quiet lines that say why a feature cannot answer. A provider that
 * needs a key says so once for every feature behind it, with Add a key; red is kept for a key that was refused.
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
  /** The provider whose key the notice asks for: the notice then offers "Add a key" for it. */
  readonly addKeyFor?: string;
  /** The features the notice speaks for, for a reader of the notice. */
  readonly features?: readonly AiFeature[];
}

/** Why a feature's chosen provider cannot answer: only `key` asks for a key. */
type Reason = 'key' | 'notRunning' | 'noSpeech' | 'unavailable' | 'learns';

/** One feature whose chosen provider cannot answer, and why. */
interface Blocked {
  readonly feature: AiFeature;
  readonly provider: string;
  readonly reason: Reason;
}

/** The reason `usableFor` said no, kept so each failure gets its own plain line. */
function reasonOf(p: AiProvider, feature: AiFeature): Reason {
  if (feature === 'voice' && !p.sttCapable) return 'noSpeech';
  if (feature !== 'voice' && p.trainsOnInputs) return 'learns';
  if (p.running === false || (p.group === 'local' && p.status === 'unreachable')) {
    return 'notRunning';
  }
  return p.status === 'missingKey' || p.status === 'notConfigured' ? 'key' : 'unavailable';
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
    out.push({ feature, provider: choice.provider, reason: reasonOf(p, feature) });
  }
  return out;
}

const REASON_LINE: Readonly<Record<Exclude<Reason, 'learns'>, string>> = {
  key: 'needs a key.',
  notRunning: 'is not running.',
  noSpeech: 'cannot turn speech into text.',
  unavailable: 'is not answering right now.',
};

/** "Ask, Summaries and Voice use Groq, which needs a key." One sentence per provider and reason. */
function reasonNotice(reason: Exclude<Reason, 'learns'>, group: readonly Blocked[]): AiNotice {
  const provider = group[0]!.provider;
  const labels = group.map(b => featureLabel(b.feature));
  const verb = group.length === 1 ? 'uses' : 'use';
  const line = REASON_LINE[reason];
  return {
    id: `${reason}-${provider}`,
    text: `${joinWords(labels)} ${verb} ${providerName(provider)}, which ${line}`,
    ...(reason === 'key' ? { addKeyFor: provider } : {}),
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
  const groups = new Map<string, Blocked[]>();
  for (const item of blocked.filter(b => b.reason !== 'learns')) {
    const key = `${item.reason}|${item.provider}`;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  const lines = [...groups.values()].map(group =>
    reasonNotice(group[0]!.reason as Exclude<Reason, 'learns'>, group),
  );
  return [...lines, ...blocked.filter(b => b.reason === 'learns').map(learnsNotice)];
}
