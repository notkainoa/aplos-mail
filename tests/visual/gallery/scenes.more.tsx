// The second half of the gallery scenes: status, empty and error lines, settings, calendar and onboarding.

import { useState, type ReactElement } from 'react';
import type {
  CalendarEventData,
  ProviderTableProps,
  StepButton,
  SyncAccount,
} from '../../../apps/desktop/src/renderer/ui/props';
import { CalendarGrid } from '../../../apps/desktop/src/renderer/ui/calendar';
import { Switch } from '../../../apps/desktop/src/renderer/ui/controls';
import {
  EmptyLine,
  ErrorLine,
  ListBox,
  ListRow,
  SectionHeader,
} from '../../../apps/desktop/src/renderer/ui/list';
import {
  ChoiceGroup,
  ChoiceRow,
  OnboardingStep,
} from '../../../apps/desktop/src/renderer/ui/onboarding';
import { ProviderTable, SettingRow } from '../../../apps/desktop/src/renderer/ui/settings';
import { ProgressSegments, StatusSlot } from '../../../apps/desktop/src/renderer/ui/status';
import { NavHead } from '../../../apps/desktop/src/renderer/ui/surfaces';
import { Column, noop, row } from './scenes.shared';

const GM: SyncAccount = { address: 'alex.moreno@gmail.com', color: 'sky' };

export function StatusScene(): ReactElement {
  return (
    <Column width="narrow">
      <StatusSlot
        status={{
          kind: 'ok',
          lastSyncedAt: '2026-10-29T09:58:00-07:00',
          reconnectBy: '2026-10-29T18:00:00-07:00',
        }}
        account={GM}
        onAction={noop}
      />
      <div className="stage__gap" />
      <StatusSlot
        status={{ kind: 'paused', reason: 'throttle', resumeAt: '2026-10-29T14:14:00-07:00' }}
        account={GM}
        onAction={noop}
      />
      <div className="stage__gap" />
      <StatusSlot status={{ kind: 'offline', changesWaiting: 3 }} onAction={noop} />
    </Column>
  );
}

export function EmptyScene(): ReactElement {
  return (
    <Column>
      <EmptyLine
        text="You handled 12 emails"
        size="display"
        placement="pane"
        detail="Nothing else needs you today"
        action={{ label: 'Go to Later', commandId: 'nav.later', emphasis: 'text', onSelect: noop }}
      />
    </Column>
  );
}

export function ErrorScene(): ReactElement {
  return (
    <Column>
      <ListBox binding={{ id: 'sent', label: 'Sent' }}>
        <ListRow
          {...row({
            id: 'e-1',
            sender: 'Jordan Park',
            primary: 'Re: A quieter home for the Hollow Creek site',
            date: '2026-10-29T09:55:00-07:00',
          })}
        />
      </ListBox>
      <div className="stage__gap" />
      <ErrorLine kind="sendFailed" recipient="Jordan" placement="column" onAction={noop} />
    </Column>
  );
}

const FEATURES: ProviderTableProps = {
  kind: 'features',
  onChange: noop,
  rows: [
    {
      feature: 'ask',
      provider: 'groq',
      model: 'openai/gpt-oss-120b',
      providerOptions: ['groq', 'openai', 'ollama'],
      modelOptions: ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile'],
    },
    {
      feature: 'summaries',
      provider: 'groq',
      model: 'llama-3.1-8b-instant',
      providerOptions: ['groq'],
      modelOptions: ['llama-3.1-8b-instant'],
    },
    {
      feature: 'drafts',
      provider: 'openai',
      model: 'gpt-5-mini',
      providerOptions: ['groq', 'openai'],
      modelOptions: ['gpt-5-mini'],
    },
    {
      feature: 'voice',
      provider: 'groq',
      model: 'whisper-large-v3-turbo',
      providerOptions: ['groq', 'openai'],
      modelOptions: ['whisper-large-v3-turbo'],
    },
  ],
};

const HOSTED: ProviderTableProps = {
  kind: 'hosted',
  onAction: noop,
  rows: [
    {
      provider: 'groq',
      isDefault: true,
      keySource: { kind: 'environment', variable: 'GROQ_API_KEY' },
      status: { kind: 'works', latencyMs: 400 },
    },
    {
      provider: 'openai',
      isDefault: false,
      keySource: { kind: 'keychain' },
      status: { kind: 'ready' },
    },
    {
      provider: 'anthropic',
      isDefault: false,
      keySource: { kind: 'none', variable: 'ANTHROPIC_API_KEY' },
      status: { kind: 'needsKey' },
    },
  ],
};

export function SettingsScene(): ReactElement {
  return (
    <div className="stage__window stage__settings">
      <aside className="stage__settings-nav">
        <NavHead label="Settings" />
      </aside>
      <div className="stage__settings-body">
        <SectionHeader id="set-ai" label="AI" variant="section" />
        <SettingRow
          id="set-private"
          label="Send mail text to a provider"
          description="Summaries and Ask send the text of the mail they read to the provider you pick."
          control={<Switch checked label="Send mail text to a provider" onChange={noop} />}
        />
        <SettingRow
          id="set-feature"
          label="Provider for each feature"
          below={<ProviderTable {...FEATURES} />}
        />
        <SettingRow id="set-hosted" label="Providers" below={<ProviderTable {...HOSTED} />} />
      </div>
    </div>
  );
}

const CAL = {
  work: { id: 'work', name: 'Work', color: 'hill' },
  personal: { id: 'personal', name: 'Personal', color: 'sky' },
  hollow: { id: 'hollow', name: 'Hollow Creek', color: 'ember' },
} as const;

function ev(
  id: string,
  title: string,
  start: string,
  end: string,
  extra: Partial<CalendarEventData> = {},
): CalendarEventData {
  return { id, title, start, end, calendar: CAL.work, kind: 'event', persisted: true, ...extra };
}

const EVENTS: readonly CalendarEventData[] = [
  ev('dental', 'Northwind Dental', '2026-10-29T09:30:00', '2026-10-29T10:30:00', {
    calendar: CAL.personal,
  }),
  ev('standup', 'Standup', '2026-10-29T11:00:00', '2026-10-29T11:15:00'),
  ev('design', 'Design review', '2026-10-29T14:00:00', '2026-10-29T14:30:00', {
    calendar: CAL.hollow,
  }),
  ev('climb', 'Climbing with Theo', '2026-10-29T17:30:00', '2026-10-29T19:00:00', {
    calendar: CAL.personal,
  }),
  ev('q4', 'Q4 review', '2026-10-30T11:00:00', '2026-10-30T12:00:00', { unanswered: true }),
  ev('lunch', 'Lunch with Leah', '2026-10-30T12:30:00', '2026-10-30T13:30:00', {
    calendar: CAL.personal,
  }),
  ev('launch', 'Launch prep', '2026-10-30T15:00:00', '2026-10-30T16:30:00', {
    calendar: CAL.hollow,
    kind: 'plan',
    persisted: false,
  }),
  ev('offsite', 'Team offsite', '2026-10-27T00:00:00', '2026-10-28T00:00:00', { allDay: true }),
];

export function CalendarScene(): ReactElement {
  return (
    <Column width="full">
      <CalendarGrid
        view="week"
        start="2026-10-26"
        events={EVENTS}
        now="2026-10-29T10:00:00"
        weekStartsOn={1}
        selectedId="design"
        onSelect={noop}
        onOpen={noop}
        onCreate={noop}
        onMove={noop}
        onResize={noop}
        onOpenStack={noop}
        label="Week of October 26"
      />
    </Column>
  );
}

const quiet = (label: string, extra: Partial<StepButton> = {}): StepButton => ({
  label,
  emphasis: 'text',
  onSelect: noop,
  ...extra,
});

/** The real Accounts step in its choose state: round 1 connects Google only, and the row itself is the choice. */
export function OnboardingScene(): ReactElement {
  return (
    <OnboardingStep
      layout="step"
      title="Add your mail"
      titleId="onb-title"
      lede="Aplos reads your mail on this Mac. Pick an account to connect."
      onTryDemo={noop}
      footer={{
        dashes: { step: 2, of: 4 },
        note: 'setupContinues',
        buttons: [quiet('Back', { keys: 'Esc', keyHint: 'hint' })],
      }}
    >
      <ChoiceRow
        id="acc-google"
        role="link"
        label="Google"
        detail="Gmail and Google Calendar"
        icon="mail"
      />
    </OnboardingStep>
  );
}

declare global {
  interface Window {
    /** Every id the choice group's onChange reported, in order (read by dom.spec). */
    __choices?: string[];
  }
}

const AI_CHOICES = [
  { id: 'ai-groq', label: 'Groq', detail: 'Fast hosted models' },
  { id: 'ai-claude', label: 'Claude', detail: 'Anthropic models' },
  { id: 'ai-local', label: 'Ollama', detail: 'On this Mac · no key needed' },
] as const;

export function ChoiceGroupScene(): ReactElement {
  const [value, setValue] = useState<string | null>('ai-groq');
  return (
    <OnboardingStep
      layout="step"
      title="Pick an AI provider"
      titleId="ai-title"
      actions={[
        {
          label: 'Continue',
          emphasis: 'filled',
          keys: 'Return',
          keyHint: 'always',
          onSelect: noop,
        },
      ]}
      footer={{
        dashes: { step: 3, of: 4 },
        note: 'setupContinues',
        buttons: [quiet('Back', { keys: 'Esc', keyHint: 'hint' })],
      }}
    >
      <ChoiceGroup
        label="AI provider"
        value={value}
        onChange={id => {
          (window.__choices ??= []).push(id);
          setValue(id);
        }}
      >
        {AI_CHOICES.map(c => (
          <ChoiceRow
            key={c.id}
            id={c.id}
            role="radio"
            label={c.label}
            detail={c.detail}
            selected={value === c.id}
          />
        ))}
      </ChoiceGroup>
    </OnboardingStep>
  );
}

export function FirstSyncScene(): ReactElement {
  return (
    <OnboardingStep
      layout="step"
      title="Getting your mail ready"
      titleId="sync-title"
      footer={{
        dashes: { step: 3, of: 4 },
        note: 'setupContinues',
        buttons: [quiet('Open Aplos', { keys: 'Return', keyHint: 'always' })],
      }}
    >
      <ProgressSegments
        variant="checkpoints"
        account={GM}
        checkpoints={[
          { step: 'connect', state: 'done' },
          { step: 'find', state: 'done', estimate: 4200 },
          { step: 'read', state: 'current', read: 1380, of: 4200 },
          { step: 'sort', state: 'pending', sorted: 0, of: 4200 },
        ]}
      />
    </OnboardingStep>
  );
}
