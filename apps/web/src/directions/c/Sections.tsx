import type { ReactNode } from 'react';

/** A section of the letter: a small green label, a serif heading, then prose. */
function Section({
  id,
  label,
  title,
  claim,
  children,
}: {
  id: string;
  label: string;
  title: string;
  claim?: string;
  children: ReactNode;
}) {
  return (
    <section className="c-col c-section" aria-labelledby={`c-${id}`}>
      <p className="c-label">{label}</p>
      <h2 id={`c-${id}`} className="c-heading" data-claim={claim}>
        {title}
      </h2>
      {children}
    </section>
  );
}

/** A summary line from the app, set as a pull quote in Aplos's serif. */
function Summary({ from, subject, children }: { from: string; subject: string; children: string }) {
  return (
    <figure className="c-quote">
      <blockquote>
        <p>{children}</p>
      </blockquote>
      <figcaption>
        <span className="c-quote-from">{from}</span>
        <span aria-hidden="true"> · </span>
        <span>{subject}</span>
      </figcaption>
    </figure>
  );
}

export function HomeSection() {
  return (
    <Section id="home" label="Home" title="One email in focus. The rest can wait.">
      <p data-claim="home-focus">
        Home gathers what needs you under Do now, then Important updates, with Low importance folded
        into a single quiet line. The first email sits in focus. Reply to it, move it to Later or
        mark it Done, and the next one takes its place.
      </p>
      <p data-claim="home-focus">
        When you would rather see nothing else at all, Go one by one shows a single email at a time.
      </p>
      <p data-claim="summaries-with-ai">
        Once AI is on, each email gets a short summary of what it says and what it needs from you,
        written in a voice of its own:
      </p>
      <div className="c-quotes" data-claim="summaries-with-ai">
        <Summary from="Jordan Park" subject="A quieter home for our project">
          Jordan wants your pick between two layouts by tomorrow.
        </Summary>
        <Summary from="Maple Library" subject="Your holds are ready to collect">
          Two books are waiting for you at the front desk until Friday.
        </Summary>
      </div>
    </Section>
  );
}

const KEYS: ReadonlyArray<readonly [string, string, string]> = [
  ['Space', 'Space', 'The main action'],
  ['←', 'Left arrow', 'Later'],
  ['→', 'Right arrow', 'Done'],
  ['Z', 'Z', 'Undo'],
  ['B', 'B', 'Bookmark'],
  ['A', 'A', 'Ask, or hold to dictate'],
  ['C', 'C', 'Compose'],
  ['?', 'Question mark', 'Every shortcut'],
];

export function KeysSection() {
  return (
    <Section
      id="keys"
      label="Keyboard"
      title="Your hands stay on the keyboard."
      claim="keyboard-first"
    >
      <p data-claim="keyboard-first">
        From the first email to the last, every step has a key, and there are only a few to learn.
      </p>
      <dl className="c-keys" data-claim="key-list">
        {KEYS.map(([cap, name, does]) => (
          <div className="c-key" key={name}>
            <dt>
              <kbd aria-label={name}>{cap}</kbd>
            </dt>
            <dd>{does}</dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}

export function CalendarSection({ figure }: { figure: ReactNode }) {
  return (
    <>
      <Section id="calendar" label="Calendar" title="Your calendar, a key away from your mail.">
        <p data-claim="google-calendar-views several-accounts">
          Your Google calendars share one day, week and month view. Connect several Google accounts
          at once and their events sit side by side.
        </p>
        <p data-claim="plans-confirm">
          When an email mentions a plan, Aplos can propose the event. It goes on your calendar only
          after you confirm.
        </p>
        <div className="c-proposal" data-claim="plans-confirm">
          <p className="c-proposal-from">Proposed from Maya Chen’s email</p>
          <p className="c-proposal-what">Community garden, Saturday at 10 AM</p>
          <p className="c-proposal-ask">
            <span className="c-proposal-yes">Add to calendar</span>
            <span className="c-proposal-no">Not now</span>
          </p>
        </div>
      </Section>
      {figure}
    </>
  );
}

export function AskSection() {
  return (
    <Section id="ask" label="Ask" title="Ask about your mail or calendar.">
      <p data-claim="ask-dictate ask-cites">
        Type a question, or hold A and say it. Ask reads your mail and calendar and cites the
        messages it used.
      </p>
      <div className="c-ask" aria-label="An example question and answer">
        <p className="c-ask-q">
          <span className="c-ask-prompt">Ask about your mail or calendar</span>
          <span className="c-ask-text">What should I bring to the garden on Saturday?</span>
        </p>
        <p className="c-ask-a">
          Gloves, and a trowel if you have one. Maya says there are tools to share, but never quite
          enough to go around.<sup>1</sup>
        </p>
        <p className="c-ask-src">
          <span className="c-ask-n">1</span>
          Maya Chen · Saturday in the community garden
        </p>
      </div>
      <p data-claim="ask-never-sends">
        Ask can draft a reply for you to review. It never sends anything on its own.
      </p>
    </Section>
  );
}

const PROVIDERS: ReadonlyArray<readonly [string, string]> = [
  ['Groq', 'The default · text and voice'],
  ['OpenAI', 'Text and voice'],
  ['Claude, Gemini', 'Text'],
  ['OpenRouter, OpenCode Go', 'Passed on to the model’s host'],
  ['Ollama, LM Studio', 'On your Mac'],
  ['Your own server', 'Yours to run'],
];

export function PrivacySection() {
  return (
    <Section
      id="privacy"
      label="AI and privacy"
      title="Your keys stay on your Mac."
      claim="keys-on-mac"
    >
      <p data-claim="groq-default provider-per-feature">
        Every AI feature runs on Groq by default. In Settings you can pick a provider for each
        feature, and that feature’s text goes only to the provider you picked.
      </p>
      <dl className="c-providers" data-claim="ai-providers ai-routers local-models">
        {PROVIDERS.map(([name, note]) => (
          <div className="c-provider" key={name}>
            <dt>{name}</dt>
            <dd>{note}</dd>
          </div>
        ))}
      </dl>
      <p data-claim="ai-providers ai-routers local-models">
        Voice works with Groq or OpenAI. OpenRouter and OpenCode Go pass each request on to the
        company that runs the model you chose. Ollama and LM Studio run on your Mac, so text sent to
        them stays there.
      </p>
      <p className="c-statement" data-claim="no-aplos-server">
        No Aplos server ever sees your mail, your calendar or your sign‑in details.
      </p>
    </Section>
  );
}
