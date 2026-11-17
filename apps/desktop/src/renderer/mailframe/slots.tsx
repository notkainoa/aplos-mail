// One letter in the double buffer. Each slot measures itself and reports once; MailFrameView decides when a pending
// slot replaces the shown one. Heights are applied instantly, never animated (research section 9 item 6).

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { frameDocument, SRCDOC_SANDBOX, URL_SANDBOX } from './document';
import { createGrowthFence } from './growth';
import { handleLinkClick } from './links';
import { relayKey } from './keys';
import { clampHeight, parseBg } from './protocol';
import { createReportListener } from './reports';
import { useAppDark } from './appTheme';
import { FRAME_PAPER, sheetKind, sheetOf } from './paper';
import { PlainText } from './PlainText';
import type { FrameSource, MailFrameKey, MailFrameReady } from './types';
import { useSealedMailKeys } from './useSealedMailKeys';

/** What every slot receives. */
export interface SlotProps<S extends FrameSource> {
  source: S;
  /** Pending slots are laid out at the final width but not seen. */
  hidden: boolean;
  findQuery?: string;
  /** Plain text: draw the quoted history. */
  showQuoted?: boolean;
  /** The first measurement; called once. */
  onMeasured: (source: FrameSource, ready: MailFrameReady) => void;
  onKey: (key: MailFrameKey) => boolean | void;
}

const HIDDEN: CSSProperties = {
  position: 'absolute',
  insetInline: 0,
  top: 0,
  visibility: 'hidden',
  pointerEvents: 'none',
};
/**
 * HTML mail sits on light paper in both themes (DESIGN 7.5); the email's own background, when it has one, paints over it.
 * The one exception is a plain email in the dark theme, which sits on the card's dark surface (`sheetOf`).
 */
const FRAME: CSSProperties = {
  display: 'block',
  boxSizing: 'content-box',
  width: 'calc(100% - 2 * var(--sheet-inset, 0px))',
  border: 0,
  // The screen sets `--sheet-inset` where the paper is a sheet on a dark pane, so the text does not touch its edge.
  padding: 'var(--sheet-inset, 0px)',
};

function useLatest<T>(value: T) {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}

/** The letter's height: the root element's laid-out box (the measure CSS keeps it at content height). */
export function measureDocument(doc: Document): number {
  const rect = doc.documentElement.getBoundingClientRect();
  return clampHeight(rect.height) ?? 1;
}

const CLEAR = /^(?:transparent|rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\))$/i;

/** The paper tint: the body's background, else the root's, else light paper (parseBg's fallback). */
export function readBg(doc: Document, view: Pick<Window, 'getComputedStyle'> = window): string {
  for (const el of [doc.body, doc.documentElement]) {
    const raw = el ? view.getComputedStyle(el).backgroundColor : '';
    if (raw && !CLEAR.test(raw.trim())) return parseBg(raw);
  }
  return parseBg(undefined);
}

/** Wire one loaded frame document: key relay, link handling, resize tracking. Returns the cleanup. */
function wireDocument(
  doc: Document,
  onKey: { current: (key: MailFrameKey) => boolean | void },
  onHeight: (height: number) => void,
): () => void {
  const keydown = (e: KeyboardEvent) => void relayKey(e, onKey.current);
  const click = (e: MouseEvent) => void handleLinkClick(e);
  const submit = (e: Event) => e.preventDefault();
  doc.addEventListener('keydown', keydown, true);
  doc.addEventListener('click', click, true);
  doc.addEventListener('auxclick', click, true);
  doc.addEventListener('submit', submit, true);
  const observer = new ResizeObserver(() => onHeight(measureDocument(doc)));
  observer.observe(doc.documentElement);
  return () => {
    observer.disconnect();
    doc.removeEventListener('keydown', keydown, true);
    doc.removeEventListener('click', click, true);
    doc.removeEventListener('auxclick', click, true);
    doc.removeEventListener('submit', submit, true);
  };
}

/** Host sentences above the letter (flattened, truncated): host DOM, so the email's CSS cannot hide or fake them. */
function Notices({ notices }: { notices: string[] }) {
  return notices.map(sentence => (
    <p key={sentence} className="aplos-mailframe__notice">
      {sentence}
    </p>
  ));
}

/**
 * The stand-in path: a scriptless, same-origin `srcdoc` frame measured from the parent. The measured height is the
 * frame's own; the notices above it are host chrome.
 */
export function SrcdocSlot(props: SlotProps<Extract<FrameSource, { kind: 'srcdoc' }>>) {
  const { source, hidden } = props;
  const dark = useAppDark();
  const built = useMemo(
    () => frameDocument(source.html, source.imagePolicy, source.findQuery, dark),
    [source.html, source.imagePolicy, source.findQuery, dark],
  );
  const [height, setHeight] = useState(1);
  const [bg, setBg] = useState(FRAME_PAPER.paper);
  const ref = useRef<HTMLIFrameElement>(null);
  const onKey = useLatest(props.onKey);
  const onMeasured = useLatest(props.onMeasured);
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanup.current?.(), []);

  const onLoad = () => {
    const doc = ref.current?.contentDocument;
    if (!doc) return;
    cleanup.current?.();
    // A fresh fence per document: viewport-unit content would otherwise grow with the frame forever (growth.ts).
    const fence = createGrowthFence();
    cleanup.current = wireDocument(doc, onKey, h => setHeight(fence.next(h)));
    const measured = fence.next(measureDocument(doc));
    setHeight(measured);
    const tint = readBg(doc);
    setBg(tint);
    onMeasured.current(source, {
      height: measured,
      bg: tint,
      blocked: built.blocked,
      trackers: built.trackers,
    });
  };

  return (
    <div style={hidden ? HIDDEN : undefined}>
      <Notices notices={built.notices} />
      <iframe
        ref={ref}
        title="Email"
        className="aplos-mailframe__frame"
        sandbox={SRCDOC_SANDBOX}
        referrerPolicy="no-referrer"
        allow=""
        tabIndex={-1}
        srcDoc={built.srcdoc}
        onLoad={onLoad}
        data-sheet={sheetKind(built.plain, bg)}
        style={{ ...FRAME, ...sheetOf(built.plain, bg), height }}
      />
    </div>
  );
}

/**
 * The sealed path: an opaque `aplos-mail://` frame sized only by validated reporter messages. The reporter relays no
 * keys (PROTOCOL.md "Keys"): `onKey` hears main's relayed keys through `useSealedMailKeys`, never a keydown listener.
 */
export function UrlSlot(props: SlotProps<Extract<FrameSource, { kind: 'url' }>>) {
  const { source, hidden } = props;
  const [height, setHeight] = useState(1);
  const [bg, setBg] = useState(FRAME_PAPER.paper);
  // The sanitiser's own marker, reported by the frame: the only thing that may flush a letter onto the card.
  const [plain, setPlain] = useState(false);
  // False until that first report: the frame then follows the app's colour scheme (`sheetOf`).
  const [reported, setReported] = useState(false);
  const ref = useRef<HTMLIFrameElement>(null);
  const onMeasured = useLatest(props.onMeasured);
  useSealedMailKeys(ref, { shown: !hidden, onKey: props.onKey });

  useEffect(() => {
    // A new letter starts on the paper: the previous letter's colour must not draw the next one until it reports.
    setBg(FRAME_PAPER.paper);
    setPlain(false);
    setReported(false);
    const listener = createReportListener({
      frame: () => ref.current,
      token: source.token,
      setHeight,
      onFirst: report => {
        setBg(report.bg);
        setPlain(report.plain);
        setReported(true);
        onMeasured.current(source, {
          height: report.height,
          bg: report.bg,
          blocked: source.blocked,
          // TODO: map trackers separately once the contract carries a blocked-image count (sealed frames report one number).
          trackers: source.blocked,
        });
      },
    });
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }, [source, onMeasured]);

  return (
    <iframe
      ref={ref}
      title="Email"
      className="aplos-mailframe__frame"
      sandbox={URL_SANDBOX}
      referrerPolicy="no-referrer"
      allow=""
      tabIndex={-1}
      src={source.url}
      data-sheet={sheetKind(plain, bg)}
      style={{ ...FRAME, ...sheetOf(plain, bg, reported), height, ...(hidden ? HIDDEN : null) }}
    />
  );
}

/** Plain text: host DOM that follows the theme. Measured synchronously after layout. */
export function TextSlot(props: SlotProps<Extract<FrameSource, { kind: 'text' }>>) {
  const { source, hidden, findQuery, showQuoted } = props;
  const ref = useRef<HTMLDivElement>(null);
  const onMeasured = useLatest(props.onMeasured);
  useLayoutEffect(() => {
    const height = clampHeight(ref.current?.getBoundingClientRect().height ?? 1) ?? 1;
    onMeasured.current(source, { height, bg: 'transparent', blocked: 0, trackers: 0 });
  }, [source, onMeasured]);
  return (
    <div ref={ref} style={{ ...(hidden ? HIDDEN : null), paddingLeft: 'var(--plain-indent, 0px)' }}>
      <PlainText
        text={source.text}
        findQuery={findQuery}
        quoted={source.quoted}
        showQuoted={showQuoted}
      />
    </div>
  );
}
