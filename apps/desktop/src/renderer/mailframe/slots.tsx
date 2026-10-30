// One letter in the double buffer. Each slot measures itself and reports once; MailFrameView decides when a pending
// slot replaces the shown one. Heights are applied instantly, never animated (research section 9 item 6).

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { frameDocument, SRCDOC_SANDBOX, URL_SANDBOX } from './document';
import { handleLinkClick } from './links';
import { relayKey } from './keys';
import { acceptReport, clampHeight, MAX_HEIGHT, parseBg } from './protocol';
import { FRAME_PAPER } from './paper';
import { PlainText } from './PlainText';
import type { FrameSource, MailFrameKey, MailFrameReady } from './types';

/** What every slot receives. */
export interface SlotProps<S extends FrameSource> {
  source: S;
  /** Pending slots are laid out at the final width but not seen. */
  hidden: boolean;
  findQuery?: string;
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
/** HTML mail sits on light paper in both themes (DESIGN 7.5); the email's own background, when it has one, paints over it. */
const FRAME: CSSProperties = {
  display: 'block',
  boxSizing: 'content-box',
  width: 'calc(100% - 2 * var(--sheet-inset, 0px))',
  border: 0,
  colorScheme: 'light',
  background: FRAME_PAPER.paper,
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
  return clampHeight(Math.min(rect.height, MAX_HEIGHT)) ?? 1;
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
  const built = useMemo(
    () => frameDocument(source.html, source.imagePolicy, source.findQuery),
    [source.html, source.imagePolicy, source.findQuery],
  );
  const [height, setHeight] = useState(1);
  const ref = useRef<HTMLIFrameElement>(null);
  const onKey = useLatest(props.onKey);
  const onMeasured = useLatest(props.onMeasured);
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanup.current?.(), []);

  const onLoad = () => {
    const doc = ref.current?.contentDocument;
    if (!doc) return;
    cleanup.current?.();
    cleanup.current = wireDocument(doc, onKey, setHeight);
    const measured = measureDocument(doc);
    setHeight(measured);
    onMeasured.current(source, { height: measured, bg: readBg(doc), blocked: built.blocked });
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
        style={{ ...FRAME, height }}
      />
    </div>
  );
}

/** The sealed path: an opaque `aplos-mail://` frame sized only by validated reporter messages. */
export function UrlSlot(props: SlotProps<Extract<FrameSource, { kind: 'url' }>>) {
  const { source, hidden } = props;
  const [height, setHeight] = useState(1);
  const ref = useRef<HTMLIFrameElement>(null);
  const onKey = useLatest(props.onKey);
  const onMeasured = useLatest(props.onMeasured);

  useEffect(() => {
    let reported = false;
    const listener = (event: MessageEvent) => {
      const frame = ref.current;
      const report = acceptReport(event, {
        source: frame?.contentWindow ?? null,
        origins: ['null'],
        token: source.token,
        width: frame?.clientWidth,
      });
      if (report?.type === 'key') onKey.current(report);
      if (report?.type !== 'size') return;
      setHeight(report.height);
      if (reported) return;
      reported = true;
      onMeasured.current(source, { height: report.height, bg: report.bg, blocked: source.blocked });
    };
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }, [source, onKey, onMeasured]);

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
      style={{ ...FRAME, height, ...(hidden ? HIDDEN : null) }}
    />
  );
}

/** Plain text: host DOM that follows the theme. Measured synchronously after layout. */
export function TextSlot(props: SlotProps<Extract<FrameSource, { kind: 'text' }>>) {
  const { source, hidden, findQuery } = props;
  const ref = useRef<HTMLDivElement>(null);
  const onMeasured = useLatest(props.onMeasured);
  useLayoutEffect(() => {
    const height = clampHeight(ref.current?.getBoundingClientRect().height ?? 1) ?? 1;
    onMeasured.current(source, { height, bg: 'transparent', blocked: 0 });
  }, [source, onMeasured]);
  return (
    <div ref={ref} style={hidden ? HIDDEN : undefined}>
      <PlainText text={source.text} findQuery={findQuery} />
    </div>
  );
}
