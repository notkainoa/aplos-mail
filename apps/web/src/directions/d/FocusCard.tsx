import { useEffect, useState, type ReactNode } from 'react';
import type { Feature } from './features';
import { DOWNLOAD_HREF } from './features';
import { CheckIcon, ClockIcon } from './icons';
import type { Commit } from './useQueue';

export const PITCH_ID = 'pitch';

export type CardActions = { onDone: () => void; onLater: () => void };

function CardHead({ sender, label }: { sender: string; label: string }) {
  return (
    <div className="card-head">
      <span className="card-sender">{sender}</span>
      <span className="card-label">{label}</span>
    </div>
  );
}

function PitchContent() {
  return (
    <>
      <h1 className="pitch-line">Finish your inbox, one email at a time.</h1>
      <p className="pitch-sub" data-claim="gmail-google-calendar summaries-with-ai">
        Aplos Mail is a Mac app for Gmail and Google Calendar. Once AI is on, each email gets a
        short summary of what it says and needs.
      </p>
    </>
  );
}

function PitchNote() {
  return (
    <p className="card-note" data-claim="invited-testers-builds">
      No public download yet. Builds are shared with invited testers.
    </p>
  );
}

function FeatureContent({ feature }: { feature: Feature }) {
  return (
    <>
      <h2 className="focus-line" data-claim={feature.summaryClaim}>
        {feature.summary}
      </h2>
      <div className="reader-body">{feature.body}</div>
      {feature.visual}
    </>
  );
}

function Actions({ onDone, onLater }: CardActions) {
  return (
    <div className="card-actions">
      <a className="btn btn-filled" href={DOWNLOAD_HREF}>
        How to get it
        <kbd className="cap cap-on-fill">Space</kbd>
      </a>
      <div className="card-triage">
        <button type="button" className="btn btn-text" onClick={onLater}>
          <ClockIcon />
          Later
          <kbd className="cap">←</kbd>
        </button>
        <button type="button" className="btn btn-text" onClick={onDone}>
          <CheckIcon />
          Done
          <kbd className="cap">→</kbd>
        </button>
      </div>
    </div>
  );
}

function CardBody({ id, feature }: { id: string; feature?: Feature }) {
  if (id === PITCH_ID || !feature) {
    return <PitchContent />;
  }
  return <FeatureContent feature={feature} />;
}

type FocusProps = CardActions & { id: string; feature?: Feature; sender: string; label: string };

/** The focus letter: sender, the serif line, then one filled action and Later / Done. */
export function FocusCard(props: FocusProps) {
  const pitch = props.id === PITCH_ID;
  return (
    <article
      className={pitch ? 'focus-card is-pitch' : 'focus-card'}
      data-focus-card=""
      tabIndex={-1}
      aria-label={`In focus: ${props.sender}`}
    >
      <CardHead sender={props.sender} label={props.label} />
      <div className="deal" key={props.id}>
        <CardBody id={props.id} feature={props.feature} />
      </div>
      <Actions onDone={props.onDone} onLater={props.onLater} />
      {pitch ? <PitchNote /> : null}
    </article>
  );
}

/** A copy of the letter that just left, carried off while the next one is already in place. */
export function Ghost({ commit, children }: { commit: Commit; children: ReactNode }) {
  const [gone, setGone] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setGone(true), 420);
    return () => window.clearTimeout(timer);
  }, []);
  if (gone) {
    return null;
  }
  return (
    <div className={`ghost ghost-${commit.kind}`} aria-hidden="true" inert>
      {children}
    </div>
  );
}

export function ZeroCard({ onReset }: { onReset: () => void }) {
  return (
    <article className="focus-card is-zero" data-focus-card="" tabIndex={-1}>
      <p className="zero-line">That’s everything on this page.</p>
      <p className="pitch-sub" data-claim="gmail-google-calendar">
        Aplos Mail is a Mac app for Gmail and Google Calendar.
      </p>
      <div className="card-actions">
        <a className="btn btn-filled" href={DOWNLOAD_HREF}>
          How to get it
        </a>
        <button type="button" className="btn btn-text" onClick={onReset}>
          Start over
        </button>
      </div>
    </article>
  );
}

export function CommitChip({ commit, onUndo }: { commit: Commit; onUndo: () => void }) {
  const done = commit.kind === 'done';
  return (
    <span className="commit" key={commit.key}>
      <span className={done ? 'chip chip-done' : 'chip chip-later'}>
        {done ? <CheckIcon /> : <ClockIcon />}
        {done ? 'Done' : 'Later'}
      </span>
      <button type="button" className="btn btn-text btn-small" onClick={onUndo}>
        Undo
        <kbd className="cap">Z</kbd>
      </button>
    </span>
  );
}
