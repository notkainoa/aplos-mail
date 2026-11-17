import { useEffect, useRef, useState } from 'react';
import { Logo } from '../../shared/brand';
import { DOWNLOAD_HREF, PRIVACY_HREF, features, type Feature } from './features';
import { CommitChip, FocusCard, Ghost, PITCH_ID, ZeroCard } from './FocusCard';
import { Rows, StaticRows } from './Rows';
import { useKeys } from './useKeys';
import { useQueue, type Commit } from './useQueue';

const pitch: Feature = {
  id: PITCH_ID,
  sender: 'Aplos Mail',
  subject: 'Finish your inbox, one email at a time',
  label: 'Now',
  summary: 'Aplos Mail is a Mac app for Gmail and Google Calendar.',
  summaryClaim: 'gmail-google-calendar',
  body: (
    <p data-claim="invited-testers-builds">
      No public download yet. Builds are shared with invited testers.
    </p>
  ),
};

const all = [pitch, ...features];
const initialOrder = all.map(item => item.id);

function find(id: string) {
  return all.find(item => item.id === id) ?? pitch;
}

function TopBar() {
  return (
    <header className="topbar">
      <a className="brand" href="../../">
        <Logo size={28} />
        <span>Aplos Mail</span>
      </a>
      <nav className="topnav" aria-label="Site">
        <a className="navlink" href={PRIVACY_HREF}>
          Privacy
        </a>
        <a className="btn btn-ring" href={DOWNLOAD_HREF}>
          How to get it
        </a>
      </nav>
    </header>
  );
}

function SectionLabel({ title, count }: { title: string; count?: number }) {
  return (
    <h2 className="section-label">
      {title}
      {count === undefined ? null : <span className="count">{count}</span>}
    </h2>
  );
}

function useOpenRows() {
  const [open, setOpen] = useState(() => new Set(['home', 'calendar']));
  function toggle(id: string) {
    setOpen(current => {
      const next = new Set(current);
      if (!next.delete(id)) {
        next.add(id);
      }
      return next;
    });
  }
  return { open, toggle };
}

function GhostCard({ commit }: { commit: Commit }) {
  const item = find(commit.id);
  const noop = () => undefined;
  return (
    <Ghost key={commit.key} commit={commit}>
      <FocusCard
        id={item.id}
        feature={item}
        sender={item.sender}
        label={item.label}
        onDone={noop}
        onLater={noop}
      />
    </Ghost>
  );
}

function Updates() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <section className="section" aria-labelledby="updates">
        <h2 className="section-label" id="updates">
          Important updates <span className="count">2</span>
        </h2>
        <StaticRows
          lines={[
            {
              sender: 'Requirements',
              text: 'macOS 13 or later, on Apple silicon or Intel',
              claim: 'macos-13 mac-chips mac-only',
              meta: 'Mac only',
            },
            {
              sender: 'Access',
              text: 'Gmail and Google Calendar are available to invited testers',
              claim: 'gmail-invited-testers',
              meta: 'Testers',
            },
          ]}
        />
      </section>
      <section className="low">
        <button
          type="button"
          className="low-band"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <span className="low-title">Low importance</span>
          <span className="low-senders">Download, Privacy and the small print</span>
          <span className="count">3</span>
        </button>
        {open ? <LowRows /> : null}
      </section>
    </>
  );
}

function LowRows() {
  return (
    <ul className="rows rows-static low-rows">
      <li className="row">
        <a className="row-head" href={DOWNLOAD_HREF}>
          <span className="row-sender">Download</span>
          <span className="row-subject">How invited testers get Aplos Mail</span>
        </a>
      </li>
      <li className="row">
        <a className="row-head" href={PRIVACY_HREF}>
          <span className="row-sender">Privacy</span>
          <span className="row-subject">What leaves your Mac, and where it goes</span>
        </a>
      </li>
      <li className="row">
        <div className="row-head">
          <span className="row-sender">About</span>
          <span className="row-subject" data-claim="mac-only">
            Independent software for Mac.
          </span>
        </div>
      </li>
    </ul>
  );
}

function Footer() {
  return (
    <footer className="footer">
      <span className="footer-brand">
        <Logo size={18} />
        <span data-claim="mac-only">Independent software for Mac.</span>
      </span>
      <nav className="footer-links" aria-label="Footer">
        <a href={DOWNLOAD_HREF}>Download</a>
        <a href={PRIVACY_HREF}>Privacy</a>
      </nav>
    </footer>
  );
}

/** After a commit, bring the focus slot back into view if the visitor has scrolled away from it. */
function useKeepInView(headId: string | undefined) {
  const ref = useRef<HTMLDivElement>(null);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const slot = ref.current;
    if (!slot) {
      return;
    }
    const top = slot.getBoundingClientRect().top;
    if (top >= 0 && top < window.innerHeight * 0.6) {
      return;
    }
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    slot.scrollIntoView({ block: 'start', behavior: still ? 'auto' : 'smooth' });
  }, [headId]);
  return ref;
}

function goDownload() {
  window.location.href = DOWNLOAD_HREF;
}

export function Page() {
  const queue = useQueue(initialOrder);
  const rows = useOpenRows();
  useKeys({ done: queue.done, later: queue.later, undo: queue.undo, main: goDownload });
  const [headId, ...restIds] = queue.order;
  const head = headId ? find(headId) : null;
  const slotRef = useKeepInView(headId);
  return (
    <div className="shell">
      <TopBar />
      <main className="pane">
        <div className="column">
          <div className="pane-head">
            <SectionLabel title="Do now" count={queue.order.length} />
            <div className="pane-tools" role="status">
              {queue.last ? <CommitChip commit={queue.last} onUndo={queue.undo} /> : null}
              <button
                type="button"
                className="btn btn-text go"
                onClick={queue.done}
                disabled={!head}
              >
                Go one by one
              </button>
            </div>
          </div>
          <div className="slot" ref={slotRef}>
            {head ? (
              <FocusCard
                id={head.id}
                feature={head}
                sender={head.sender}
                label={head.label}
                onDone={queue.done}
                onLater={queue.later}
              />
            ) : (
              <ZeroCard onReset={queue.reset} />
            )}
            {queue.last ? <GhostCard commit={queue.last} /> : null}
          </div>
          <p className="hint" aria-hidden="true">
            Press <kbd className="cap">→</kbd> for the next one, or open any row below.
          </p>
          <Rows items={restIds.map(find)} open={rows.open} onToggle={rows.toggle} />
          <Updates />
        </div>
      </main>
      <Footer />
    </div>
  );
}
