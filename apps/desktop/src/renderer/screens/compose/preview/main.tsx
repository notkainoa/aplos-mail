/**
 * The recipient type-ahead on its own (development only). Vite serves it at
 * `/src/renderer/screens/compose/preview/index.html?theme=light|dark`; it draws the composer's To, Cc and Bcc rows
 * over a small made-up address book (original names, example.com addresses), asked through the same `suggest` seam
 * the app fills with `Contact/suggest`. `shoot.mjs` drives it headlessly with the keyboard.
 */
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../../ui/styles.css';
import '../compose.css';
import { Pane } from '../../../ui/surfaces';
import { EMPTY_FIELDS, type ComposeFields } from '../model/fields';
import type { SuggestEntry, SuggestFn } from '../model/suggestions';
import { RecipientRows } from '../views/RecipientRows';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') === 'dark' ? 'dark' : 'light';

const BOOK: readonly SuggestEntry[] = [
  { address: 'jordan.lee@example.com', name: 'Jordan Lee', sentTo: 14, receivedFrom: 9 },
  { address: 'joanna.pierce@example.com', name: 'Joanna Pierce', sentTo: 6, receivedFrom: 11 },
  { address: 'jonas@example.org', sentTo: 1, receivedFrom: 4 },
  { address: 'mina.okafor@example.com', name: 'Mina Okafor', sentTo: 22, receivedFrom: 30 },
  { address: 'miles.arden@example.com', name: 'Miles Arden', sentTo: 2, receivedFrom: 3 },
];

/** A made-up address book that answers after a short wait, like the engine does. Matches the start of name or address. */
const none = params.get('none') === '1';
const suggest: SuggestFn = async query => {
  await new Promise(r => setTimeout(r, 40));
  if (none) return [];
  const q = query.toLowerCase();
  return BOOK.filter(
    p =>
      p.address.toLowerCase().startsWith(q) ||
      (p.name ?? '')
        .toLowerCase()
        .split(' ')
        .some(w => w.startsWith(q)),
  );
};

function Preview() {
  const [fields, setFields] = useState<ComposeFields>(EMPTY_FIELDS);
  return (
    <div className="cmp-frame">
      <Pane kind="main" label="Compose preview">
        <div className="cmp-card">
          <RecipientRows
            fields={fields}
            accountId="demo-account"
            onChange={patch => setFields({ ...fields, ...patch })}
            showCc
            onShowCc={() => {}}
            invalid={[]}
            suggest={suggest}
          />
          <p className="cmp-note" data-testid="to-list">
            {fields.to.map(r => r.address).join(', ')}
          </p>
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
