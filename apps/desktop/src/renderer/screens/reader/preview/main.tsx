/**
 * The reader's "Add to calendar" offer on its own (development only). Vite serves it at
 * `/src/renderer/screens/reader/preview/index.html?theme=light|dark&state=one|two|none`: the serif summary, then the
 * offer cards the thread's open plans make (original demo wording), over the column the reader uses.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../../../ui/styles.css';
import '../reader.css';
import type { Plan } from '../../../data';
import { ReaderHead } from '../../../ui/reader';
import { Pane } from '../../../ui/surfaces';
import { EventOfferCard } from '../EventOffer';
import { offersOf } from '../offerModel';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') === 'dark' ? 'dark' : 'light';
const state = params.get('state') ?? 'one';

const base = {
  rev: 1,
  threadId: 't1',
  allDay: false,
  state: 'open',
} as const satisfies Partial<Plan>;
const PLANS: readonly Plan[] = [
  {
    ...base,
    id: 'a:plan-1',
    title: 'Design review with Mina',
    start: { type: 'floating', local: '2026-11-12T15:00:00' },
    end: { type: 'floating', local: '2026-11-12T16:00:00' },
    location: 'Hollow Creek, room 4',
  },
  {
    ...base,
    id: 'a:plan-2',
    title: 'Launch checklist walkthrough',
    start: { type: 'floating', local: '2026-11-13T10:30:00' },
    end: { type: 'floating', local: '2026-11-13T11:00:00' },
  },
];

function Preview() {
  const offers = state === 'none' ? [] : offersOf(state === 'two' ? PLANS : PLANS.slice(0, 1), 's');
  return (
    <div className="rdr-frame">
      <Pane kind="main" label="Reader preview">
        <div className="aplos-reader" data-cards="a">
          <ReaderHead
            summary={{
              state: 'ready',
              subject: 'Design review and launch checklist',
              provenance: { provider: 'Groq', local: false },
              text: 'Mina wants to walk through the design on Thursday afternoon and agree the launch checklist.',
            }}
          />
          {offers.length > 0 ? (
            <div className="aplos-reader__offers">
              {offers.map(o => (
                <EventOfferCard key={o.planId} offer={o} onAdd={() => undefined} />
              ))}
            </div>
          ) : null}
        </div>
      </Pane>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Preview />
  </StrictMode>,
);
