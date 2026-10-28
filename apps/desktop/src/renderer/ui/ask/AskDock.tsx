import { useId, useRef } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import type { CSSProperties } from 'react';
import type { AskDockProps, AskEmptyData } from '../props';
import { DictationLine } from '../compose/DictationLine';
import { describeKeys } from '../compose/keycaps';
import { Btn } from '../compose/parts';
import { formatRecent } from './format';

/** The dock's width range: 300 to 440, 360 by default (DESIGN §4.4). */
export const DOCK_MIN = 300;
export const DOCK_MAX = 440;
const STEP = 16;

function clampWidth(width: number): number {
  const value = Number.isFinite(width) ? width : 360;
  return Math.min(DOCK_MAX, Math.max(DOCK_MIN, Math.round(value)));
}

/** The empty view: three plain suggestions and recent chats with times. The field keeps focus; the cursor is a data attribute. */
function EmptyView({ empty, listId }: { empty: AskEmptyData; listId: string }) {
  const { suggestions, recents, cursorIndex, onPickSuggestion, onOpenRecent } = empty;
  const suggestId = `${listId}-suggest`;
  const recentId = `${listId}-recent`;
  return (
    <div
      id={listId}
      className="ui-ask-dock__empty"
      role="listbox"
      aria-label="Suggestions and recent chats"
    >
      <div role="group" aria-labelledby={suggestId}>
        <div id={suggestId} className="ui-ask-dock__group-label">
          Try asking
        </div>
        {suggestions.slice(0, 3).map((question, index) => (
          <div
            key={`${index}:${question}`}
            id={`${listId}-s${index}`}
            className="ui-ask-dock__option"
            role="option"
            aria-selected={cursorIndex === index}
            data-cursor={cursorIndex === index ? 'true' : undefined}
            onMouseDown={event => event.preventDefault()}
            onClick={() => onPickSuggestion(question)}
          >
            <span className="ui-ask-dock__option-text" dir="auto">
              {question}
            </span>
          </div>
        ))}
      </div>
      {recents.length > 0 ? (
        <div role="group" aria-labelledby={recentId}>
          <div id={recentId} className="ui-ask-dock__group-label">
            Recent
          </div>
          {recents.map((recent, index) => {
            const at = Math.min(3, suggestions.length) + index;
            return (
              <div
                key={recent.id}
                id={`${listId}-r${index}`}
                className="ui-ask-dock__option"
                role="option"
                aria-selected={cursorIndex === at}
                data-cursor={cursorIndex === at ? 'true' : undefined}
                onMouseDown={event => event.preventDefault()}
                onClick={() => onOpenRecent(recent.id)}
              >
                <span className="ui-ask-dock__option-text" data-recent="true" dir="auto">
                  {recent.question}
                </span>
                <span className="ui-ask-dock__option-time">{formatRecent(recent.at)}</span>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The Ask dock: a second pane, 360 px by default and resizable from 300 to 440 (DESIGN §6 AskDock, §7.7). Header: an
 * Ask | Today segmented control and a close button, no glyph. The field is never disabled: while an answer streams,
 * Return queues a follow-up as a small editable card and ⌘Return sends it now. The proposal and the answers are
 * AskTurns the screen passes in as `conversation`. The slide in and out (`dock`) is the motion runtime's.
 * Esc (stop, then clear, then close) and ↑/↓ over suggestions belong to the registry's ask context.
 */
export function AskDock(props: AskDockProps) {
  const {
    tab,
    onTabChange,
    onClose,
    width,
    onWidthChange,
    providerReady,
    onOpenSettings,
    conversation,
    empty,
    today,
    value,
    onChange,
    onSubmit,
    working,
    onStop,
    queued,
    onQueuedChange,
    onSendQueuedNow,
    dictation,
    fieldRef,
  } = props;
  const baseId = useId();
  const drag = useRef<{ x: number; width: number } | null>(null);
  const size = clampWidth(width);
  const emptyId = `${baseId}-empty`;
  const showEmpty = tab === 'ask' && providerReady && !conversation && Boolean(empty);
  const cursor = showEmpty ? empty?.cursorIndex : undefined;
  const total = empty ? Math.min(3, empty.suggestions.length) + empty.recents.length : 0;
  let activeOption: string | undefined;
  if (showEmpty && empty && cursor !== undefined && cursor >= 0 && cursor < total) {
    const suggested = Math.min(3, empty.suggestions.length);
    activeOption =
      cursor < suggested ? `${emptyId}-s${cursor}` : `${emptyId}-r${cursor - suggested}`;
  }
  const sendNowKeys = describeKeys('ask.sendNow');

  function onResizeDown(event: PointerEvent<HTMLDivElement>) {
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = { x: event.clientX, width: size };
  }
  function onResizeMove(event: PointerEvent<HTMLDivElement>) {
    if (!drag.current) return;
    // The dock sits on the right, so dragging its left edge leftwards makes it wider.
    onWidthChange(clampWidth(drag.current.width + (drag.current.x - event.clientX)));
  }
  function onResizeUp(event: PointerEvent<HTMLDivElement>) {
    drag.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  }
  function onResizeKey(event: KeyboardEvent<HTMLDivElement>) {
    const next =
      event.key === 'ArrowLeft'
        ? size + STEP
        : event.key === 'ArrowRight'
          ? size - STEP
          : event.key === 'Home'
            ? DOCK_MIN
            : event.key === 'End'
              ? DOCK_MAX
              : null;
    if (next === null) return;
    event.preventDefault();
    onWidthChange(clampWidth(next));
  }
  function onTabsKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      onTabChange(tab === 'ask' ? 'today' : 'ask');
    }
  }
  function onFieldKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing || event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    onSubmit(event.metaKey ? 'searchAll' : 'ask');
  }

  const tabs = [
    { id: 'ask', label: 'Ask' },
    { id: 'today', label: 'Today' },
  ] as const;

  return (
    <aside
      className="ui-ask-dock"
      aria-label="Ask"
      data-tab={tab}
      style={{ '--ask-dock-w': `${size}px` } as CSSProperties}
    >
      <div
        className="ui-ask-dock__resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize Ask"
        aria-valuenow={size}
        aria-valuemin={DOCK_MIN}
        aria-valuemax={DOCK_MAX}
        tabIndex={0}
        onPointerDown={onResizeDown}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeUp}
        onPointerCancel={onResizeUp}
        onKeyDown={onResizeKey}
      />
      <header className="ui-ask-dock__head">
        <div
          className="ui-ask-dock__tabs"
          role="tablist"
          aria-label="Ask or Today"
          onKeyDown={onTabsKey}
        >
          {tabs.map(item => (
            <button
              key={item.id}
              type="button"
              role="tab"
              id={`${baseId}-tab-${item.id}`}
              className="ui-ask-dock__tab"
              aria-selected={tab === item.id}
              aria-controls={tab === item.id ? `${baseId}-panel` : undefined}
              tabIndex={tab === item.id ? 0 : -1}
              onClick={() => onTabChange(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <Btn
          variant="icon"
          icon="close"
          label="Close"
          hint="Close Ask"
          commandId="ask.toggleDock"
          onPress={() => onClose()}
        />
      </header>
      <div
        className="ui-ask-dock__body"
        role="tabpanel"
        id={`${baseId}-panel`}
        aria-labelledby={`${baseId}-tab-${tab}`}
      >
        {tab === 'today' ? today : null}
        {tab === 'ask' && !providerReady ? (
          <div className="ui-ask-dock__noprovider">
            <p>Ask needs a provider. Choose one in Settings.</p>
            <button type="button" className="ui-ask-dock__link" onClick={onOpenSettings}>
              Open Settings → AI
            </button>
          </div>
        ) : null}
        {tab === 'ask' && providerReady && conversation ? conversation : null}
        {showEmpty && empty ? <EmptyView empty={empty} listId={emptyId} /> : null}
      </div>
      {tab === 'ask' ? (
        <footer className="ui-ask-dock__foot">
          {queued.map(card => (
            <div
              key={card.id}
              className="ui-ask-dock__queued"
              role="group"
              aria-label="Queued follow-up"
            >
              <div className="ui-ask-dock__queued-head">
                <span>{`Queued · ${sendNowKeys} sends now`}</span>
                <Btn
                  variant="text"
                  label="Send now"
                  tabIndex={-1}
                  onPress={() => onSendQueuedNow(card.id)}
                />
              </div>
              <textarea
                className="ui-ask-dock__queued-text"
                rows={1}
                dir="auto"
                aria-label="Queued follow-up"
                value={card.text}
                onChange={event => onQueuedChange(card.id, event.target.value)}
                onKeyDown={event => {
                  if (event.nativeEvent.isComposing) return;
                  if (event.metaKey && event.key === 'Enter') {
                    event.preventDefault();
                    onSendQueuedNow(card.id);
                  }
                }}
              />
            </div>
          ))}
          <div
            className="ui-ask-dock__field"
            data-dictating={dictation ? 'true' : undefined}
            data-working={working ? 'true' : undefined}
          >
            <div className="ui-ask-dock__field-row">
              <textarea
                ref={fieldRef}
                className="ui-ask-dock__input"
                rows={1}
                dir="auto"
                aria-label="Ask"
                placeholder="Ask about your mail or calendar"
                aria-controls={activeOption ? emptyId : undefined}
                aria-activedescendant={activeOption}
                value={value}
                onChange={event => onChange(event.target.value)}
                onKeyDown={onFieldKey}
              />
              <span className="ui-ask-dock__acts">
                {working ? (
                  <Btn
                    variant="text"
                    label="Stop"
                    hint="Stop the answer"
                    commandId="ask.stop"
                    onPress={() => onStop()}
                  />
                ) : null}
                <Btn
                  variant="icon"
                  icon="arrow-up"
                  label="Ask"
                  commandId="ask.submit"
                  onPress={() => onSubmit('ask')}
                />
              </span>
            </div>
            {dictation ? <DictationLine dictation={dictation} /> : null}
          </div>
        </footer>
      ) : null}
    </aside>
  );
}
