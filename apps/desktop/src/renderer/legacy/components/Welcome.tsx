import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, KeyRound, Mail, Mic } from '../icons';
import { AppIcon } from './AppIcon';
import type { Capabilities, Settings } from '@aplos/contract/legacy/types';
import {
  aiFeatures,
  askProvider,
  voiceProviders,
  type AiModelSetting,
  type AskProviderId,
} from '@aplos/contract/legacy/ask';
import { invoke } from '../bridge';
import { Button, Dialog, Kbd, Keys, Select, Spinner, cx } from '../ui';
import { AddAccountDialog } from './AddAccount';
import { ApiKeyField, useKeyStore } from './ApiKey';

/** Opens the welcome flow again (Settings → Help & about). */
export function showWelcome() {
  dispatchEvent(new Event('aplos:welcome'));
}

type Step = 'start' | 'ai' | 'mic' | 'done';
const steps: Step[] = ['start', 'ai', 'mic', 'done'];
/** Providers that take a pasted key. Local servers need an address too, so they stay in Settings → AI. */
const keyed: AskProviderId[] = [
  'groq',
  'openai',
  'anthropic',
  'gemini',
  'openrouter',
  'opencode-go',
];
type Microphone = 'unknown' | 'not-determined' | 'granted' | 'denied' | 'restricted' | 'asking';

/**
 * The first-run flow: welcome, an account (the usual add-account dialog), an AI key, the microphone, then the keys that
 * matter. Each step can be skipped, Escape included; finishing or skipping the last step marks it done for good.
 */
export function Welcome({
  open,
  capabilities,
  settings,
  onSettings,
  onFinish,
  notify,
}: {
  open: boolean;
  capabilities: Capabilities;
  settings: Settings;
  onSettings: (patch: Partial<Settings>) => void;
  onFinish: () => void;
  notify: (text: string) => void;
}) {
  const [step, setStep] = useState<Step>('start');
  const [adding, setAdding] = useState(false);
  const connected = useRef(false);
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) {
      setStep('start');
      setAdding(false);
    }
  }, [open]);
  // Each step puts focus on its main action, so Enter moves on and Tab starts from there.
  // Without one (nothing to type, Continue not ready yet) the dialog itself takes focus, so Escape still skips.
  useEffect(() => {
    if (!open || adding) return;
    const frame = requestAnimationFrame(() => {
      const el = body.current;
      (
        el?.querySelector<HTMLElement>('[data-autofocus]:not([disabled])') ??
        el?.closest<HTMLElement>('[role="dialog"]')
      )?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [step, open, adding]);
  const next = () => {
    const i = steps.indexOf(step);
    if (i >= steps.length - 1) onFinish();
    else setStep(steps[i + 1]);
  };
  const index = steps.indexOf(step);
  return (
    <>
      {/* Stays mounted under the add-account dialog, hidden, so closing that one returns focus here rather than to the page. */}
      <Dialog
        open={open}
        onClose={step === 'start' ? onFinish : next}
        dismissable={false}
        label="Welcome to Aplos Mail"
        className={cx('welcome onboarding', adding && 'is-covered')}
      >
        <div ref={body} className="onboarding-step" key={step}>
          {step === 'start' && (
            <>
              <AppIcon size={72} />
              <h1>Welcome to Aplos.</h1>
              <p>Your mail and calendar, one calm email at a time.</p>
              <div className="onboarding-actions is-stacked">
                <Button
                  variant="primary"
                  size="lg"
                  icon={Mail}
                  data-autofocus
                  onClick={() => {
                    connected.current = false;
                    setAdding(true);
                  }}
                >
                  Add an account
                </Button>
                <Button
                  variant="secondary"
                  size="lg"
                  iconRight={ArrowRight}
                  onClick={() => setStep('ai')}
                >
                  Look around with demo mail
                </Button>
              </div>
              <p className="welcome-footnote">
                Gmail, Outlook, iCloud, Fastmail, Yahoo, AOL and other IMAP mail.
                <br />
                The demo uses original sample mail. Nothing is sent to real people.
              </p>
            </>
          )}
          {step === 'ai' && <AiStep settings={settings} onSettings={onSettings} onNext={next} />}
          {step === 'mic' && <MicStep desktop={capabilities.desktop} onNext={next} />}
          {step === 'done' && (
            <>
              <span className="onboarding-glyph">
                <Check size={20} />
              </span>
              <h2>You’re set.</h2>
              <p>Four keys do most of the work. Every button shows its own.</p>
              <dl className="onboarding-keys">
                <div>
                  <dt>
                    <Kbd>Space</Kbd>
                  </dt>
                  <dd>Do what the email asks</dd>
                </div>
                <div>
                  <dt>
                    <Kbd>A</Kbd>
                  </dt>
                  <dd>Ask anything. Hold it to talk</dd>
                </div>
                <div>
                  <dt>
                    <Keys combo="J K" />
                  </dt>
                  <dd>Next and previous email</dd>
                </div>
                <div>
                  <dt>
                    <Kbd>?</Kbd>
                  </dt>
                  <dd>Every shortcut</dd>
                </div>
              </dl>
              <div className="onboarding-actions">
                <Button variant="primary" size="lg" data-autofocus onClick={onFinish}>
                  Start
                </Button>
              </div>
            </>
          )}
        </div>
        <footer className="onboarding-foot">
          <span
            className="onboarding-dots"
            role="img"
            aria-label={`Step ${index + 1} of ${steps.length}`}
          >
            {steps.map((s, i) => (
              <i key={s} className={cx(i === index && 'is-current', i < index && 'is-past')} />
            ))}
          </span>
          <span className="onboarding-skip">
            <Kbd size="sm">esc</Kbd>
            {step === 'start' ? 'Skip setup' : step === 'done' ? 'Close' : 'Skip this step'}
          </span>
        </footer>
      </Dialog>
      <AddAccountDialog
        open={open && adding}
        capabilities={capabilities}
        connected={() => {
          connected.current = true;
          notify('Account connected');
        }}
        close={() => {
          setAdding(false);
          if (connected.current) setStep('ai');
        }}
      />
    </>
  );
}

/** A provider and its key, Groq first. Saving a key for another provider while Groq has none moves the text features to it. */
function AiStep({
  settings,
  onSettings,
  onNext,
}: {
  settings: Settings;
  onSettings: (patch: Partial<Settings>) => void;
  onNext: () => void;
}) {
  const { store, update } = useKeyStore();
  const [id, setId] = useState<AskProviderId>('groq');
  const info = store?.providers[id] ?? {},
    ready = !!info.source,
    groqReady = !!store?.providers.groq?.source;
  const p = askProvider(id),
    moves = id !== 'groq' && ready && !groqReady;
  function go() {
    if (moves) {
      const model = `${id}:${p.models[0]!.id}`,
        patch: Partial<Record<AiModelSetting, string>> = {};
      for (const f of aiFeatures)
        if (f.id !== 'voice' && settings[f.setting].startsWith('groq:')) patch[f.setting] = model;
      if (voiceProviders[id] && settings.voiceModel.startsWith('groq:'))
        patch.voiceModel = `${id}:${voiceProviders[id]![0].id}`;
      onSettings(patch);
    }
    onNext();
  }
  return (
    <>
      <span className="onboarding-glyph">
        <KeyRound size={19} />
      </span>
      <h2>Connect an AI provider</h2>
      <p>
        Summaries, Ask, drafts and voice run on a provider you choose, with your own key. Groq is
        fast and has a free plan.
      </p>
      <div className="onboarding-form">
        <div className="onboarding-provider">
          <span>Provider</span>
          <Select
            label="AI provider"
            variant="field"
            value={id}
            options={keyed.map(k => [k, askProvider(k).label] as [AskProviderId, string])}
            onChange={value => setId(value)}
          />
        </div>
        {store ? (
          <ApiKeyField
            key={id}
            provider={id}
            info={info}
            store={store}
            onChange={next => update(id, next)}
            autoFocus
          />
        ) : (
          <span className="onboarding-loading">
            <Spinner size={13} />
          </span>
        )}
        <p className="onboarding-hint">
          {moves
            ? `Ask, Summaries, Drafts and Plans will use ${p.label}. You can change each in Settings → AI.`
            : 'Ollama, LM Studio and your own server are in Settings → AI.'}
        </p>
      </div>
      <div className="onboarding-actions">
        <Button variant="text" onClick={onNext}>
          Skip for now
        </Button>
        <Button
          variant="primary"
          iconRight={ArrowRight}
          disabled={!ready}
          data-autofocus={ready || undefined}
          onClick={go}
        >
          Continue
        </Button>
      </div>
    </>
  );
}

/** Hold-to-talk, and the microphone permission now or later. The status check never shows the macOS prompt by itself. */
function MicStep({ desktop, onNext }: { desktop: boolean; onNext: () => void }) {
  const [mic, setMic] = useState<Microphone>('unknown');
  useEffect(() => {
    let live = true;
    const set = (value: Microphone) => {
      if (live) setMic(value);
    };
    if (desktop)
      void invoke<{ status: Microphone }>('system.microphone', { check: true })
        .then(r => set(r.status))
        .catch(() => {});
    else
      void navigator.permissions
        ?.query({ name: 'microphone' as PermissionName })
        .then(r => set(r.state === 'prompt' ? 'not-determined' : r.state))
        .catch(() => {});
    return () => {
      live = false;
    };
  }, [desktop]);
  async function ask() {
    setMic('asking');
    try {
      if (desktop) {
        const result = await invoke<{ granted: boolean; status: Microphone }>('system.microphone');
        setMic(
          result.granted
            ? 'granted'
            : result.status === 'not-determined'
              ? 'not-determined'
              : 'denied',
        );
      } else {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach(t => t.stop());
        setMic('granted');
      }
    } catch {
      setMic('denied');
    }
  }
  const granted = mic === 'granted',
    blocked = mic === 'denied' || mic === 'restricted';
  return (
    <>
      <span className="onboarding-glyph">
        <Mic size={19} />
      </span>
      <h2>Talk instead of typing</h2>
      <p>
        Hold <Kbd size="sm">A</Kbd> to ask out loud, or hold <Kbd size="sm">Space</Kbd> in a reply
        to dictate. Let go and Aplos writes it out.
      </p>
      <p
        className={cx('onboarding-status', granted && 'is-ok', blocked && 'is-blocked')}
        role="status"
        aria-live="polite"
      >
        {granted ? (
          <>
            <span className="ai-check-mark">
              <Check size={10} />
            </span>
            The microphone is ready.
          </>
        ) : blocked ? (
          'macOS is blocking the microphone. Turn on Aplos Mail in System Settings → Privacy & Security → Microphone.'
        ) : (
          'Aplos only listens while you hold the key. Recordings go to your Voice model and aren’t kept.'
        )}
      </p>
      <div className="onboarding-actions">
        {granted ? (
          <Button variant="primary" iconRight={ArrowRight} data-autofocus onClick={onNext}>
            Continue
          </Button>
        ) : (
          <>
            <Button variant="text" onClick={onNext}>
              Later
            </Button>
            <Button
              variant="primary"
              icon={Mic}
              loading={mic === 'asking'}
              data-autofocus
              onClick={() => void ask()}
            >
              {blocked ? 'Try again' : 'Allow microphone'}
            </Button>
          </>
        )}
      </div>
    </>
  );
}
