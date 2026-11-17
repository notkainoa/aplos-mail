import type { ReactNode } from 'react';
import { AskMock, KeyGrid, ProviderMock, Shot } from './visuals';

export type Feature = {
  id: string;
  sender: string;
  subject: string;
  label: string;
  summary: string;
  summaryClaim: string;
  body: ReactNode;
  visual?: ReactNode;
};

export const PRIVACY_HREF = '../../privacy/';
export const DOWNLOAD_HREF = '../../download/';

export const features: Feature[] = [
  {
    id: 'home',
    sender: 'Home',
    subject: 'One email in focus, the rest in quiet rows',
    label: '9:41 AM',
    summary: 'Home puts the email that needs you in focus. Reply, Later or Done brings the next.',
    summaryClaim: 'home-focus',
    body: (
      <p data-claim="summaries-with-ai">
        Once AI is on, emails get a short summary of what they say and need. Everything else waits
        below in calm rows, one line each.
      </p>
    ),
    visual: (
      <Shot
        name="home"
        alt="Aplos Mail Home: Jordan Park’s email in focus with Reply, Later and Done, five more emails below it."
      />
    ),
  },
  {
    id: 'calendar',
    sender: 'Calendar',
    subject: 'Day, week and month, for every Google calendar',
    label: '9:12 AM',
    summary: 'Your Google calendars share one day, week and month view.',
    summaryClaim: 'google-calendar-views',
    body: (
      <>
        <p data-claim="plans-confirm">
          When an email mentions a plan, Aplos can propose the event. It adds it only after you
          confirm.
        </p>
        <p data-claim="several-accounts">
          Connect several Google accounts at once. Their events sit in the same week.
        </p>
      </>
    ),
    visual: (
      <Shot
        name="calendar"
        alt="The Aplos Mail calendar: a week in November with events from two accounts."
      />
    ),
  },
  {
    id: 'ask',
    sender: 'Ask',
    subject: 'Ask about your mail or calendar',
    label: '8:30 AM',
    summary: 'Ask reads your mail and calendar, and cites the messages it used.',
    summaryClaim: 'ask-cites',
    body: (
      <>
        <p data-claim="ask-dictate">Type a question, or hold A to dictate it.</p>
        <p data-claim="ask-never-sends">
          Ask drafts replies for you to review. It never sends on its own.
        </p>
      </>
    ),
    visual: <AskMock />,
  },
  {
    id: 'keys',
    sender: 'Keys',
    subject: 'Space, then left or right, then the next email',
    label: 'Yesterday',
    summary: 'Your hands stay on the keyboard from the first email to the last.',
    summaryClaim: 'keyboard-first',
    body: (
      <p data-claim="key-list">
        Space runs the main action. The left arrow moves an email to Later, the right arrow marks it
        Done, and Z undoes either.
      </p>
    ),
    visual: <KeyGrid />,
  },
  {
    id: 'ai',
    sender: 'AI on your terms',
    subject: 'Groq by default, or the provider you choose',
    label: 'Nov 14',
    summary: 'Every AI feature runs on Groq by default. You can pick a provider for each one.',
    summaryClaim: 'groq-default provider-per-feature',
    body: (
      <p data-claim="ai-providers">
        Choose from Groq, OpenAI, Claude, Gemini, OpenRouter, OpenCode Go, Ollama, LM Studio or your
        own server. Voice uses Groq or OpenAI.
      </p>
    ),
    visual: <ProviderMock />,
  },
  {
    id: 'privacy',
    sender: 'Privacy',
    subject: 'Your mail, your keys, your Mac',
    label: 'Nov 13',
    summary: 'No Aplos server ever sees your mail, calendar or sign-in details.',
    summaryClaim: 'no-aplos-server',
    body: (
      <>
        <p data-claim="keys-on-mac">Your AI keys stay on your Mac.</p>
        <p data-claim="local-models">
          Ollama and LM Studio run on your Mac at their default addresses, so text you send to them
          stays there.
        </p>
        <p>
          <a className="link" href={PRIVACY_HREF}>
            Read the privacy page
          </a>
        </p>
      </>
    ),
  },
];
