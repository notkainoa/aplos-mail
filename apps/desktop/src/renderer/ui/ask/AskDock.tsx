import { useEffect, useId, useRef } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import type { CSSProperties } from 'react';
import type { AskDockProps, AskEmptyData } from '../props';
import { DictationLine } from '../compose/DictationLine';
import { describeKeys } from '../compose/keycaps';
import { Icon } from '../compose/icons';
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
            data-kind="suggestion"
            role="option"
            aria-selected={cursorIndex === index}
            data-cursor={cursorIndex === index ? 'true' : undefined}
            onMouseDown={event => event.preventDefault()}
            onClick={() => onPickSuggestion(question)}
          >
            <Icon name="bubble" size="sm" />
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

/** The id of the empty view's option under the cursor, for the field's aria-activedescendant. */
function activeOptionOf(
  empty: AskEmptyData | undefined,
  show: boolean,
  emptyId: string,
): string | undefined {
  if (!show || !empty) return undefined;
  const cursor = empty.cursorIndex;
  const suggested = Math.min(3, empty.suggestions.length);
  const total = suggested + empty.recents.length;
  if (cursor === undefined || cursor < 0 || cursor >= total) return undefined;
  return cursor < suggested ? `${emptyId}-s${cursor}` : `${emptyId}-r${cursor - suggested}`;
}

const RESIZE_KEYS = new Map<string, (size: number) => number>([
  ['ArrowLeft', size => size + STEP],
  ['ArrowRight', size => size - STEP],
  ['Home', () => DOCK_MIN],
  ['End', () => DOCK_MAX],
]);

/** The drag and keyboard handlers of the dock's left edge. */
function useResize(size: number, onWidthChange: (width: number) => void) {
  const drag = useRef<{ x: number; width: number } | null>(null);
  return {
    onPointerDown(event: PointerEvent<HTMLDivElement>) {
      event.currentTarget.setPointerCapture?.(event.pointerId);
      drag.current = { x: event.clientX, width: size };
    },
    onPointerMove(event: PointerEvent<HTMLDivElement>) {
      if (!drag.current) return;
      // The dock sits on the right, so dragging its left edge leftwards makes it wider.
      onWidthChange(clampWidth(drag.current.width + (drag.current.x - event.clientX)));
    },
    onPointerUp(event: PointerEvent<HTMLDivElement>) {
      drag.current = null;
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    },
    onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
      const next = RESIZE_KEYS.get(event.key)?.(size);
      if (next === undefined) return;
      event.preventDefault();
      onWidthChange(clampWidth(next));
    },
  };
}

const TABS = [
  { id: 'ask', label: 'Ask' },
  { id: 'today', label: 'Today' },
] as const;

/** The Ask | Today segmented control and the close button. */
function DockHead({
  baseId,
  tab,
  onTabChange,
  onClose,
}: Pick<AskDockProps, 'tab' | 'onTabChange' | 'onClose'> & { baseId: string }) {
  function onTabsKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      onTabChange(tab === 'ask' ? 'today' : 'ask');
    }
  }
  return (
    <header className="ui-ask-dock__head">
      <div
        className="ui-ask-dock__tabs"
        role="tablist"
        aria-label="Ask or Today"
        onKeyDown={onTabsKey}
      >
        {TABS.map(item => (
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
  );
}

/** One queued follow-up: an editable card; ⌘Return sends it now. */
function QueuedCard({
  card,
  sendNowKeys,
  onChange,
  onSendNow,
}: {
  card: AskDockProps['queued'][number];
  sendNowKeys: string;
  onChange: AskDockProps['onQueuedChange'];
  onSendNow: AskDockProps['onSendQueuedNow'];
}) {
  return (
    <div className="ui-ask-dock__queued" role="group" aria-label="Queued follow-up">
      <div className="ui-ask-dock__queued-head">
        <span>{`Queued · ${sendNowKeys} sends now`}</span>
        <Btn variant="text" label="Send now" tabIndex={-1} onPress={() => onSendNow(card.id)} />
      </div>
      <textarea
        className="ui-ask-dock__queued-text"
        rows={1}
        dir="auto"
        aria-label="Queued follow-up"
        value={card.text}
        onChange={event => onChange(card.id, event.target.value)}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing) return;
          if (event.metaKey && event.key === 'Enter') {
            event.preventDefault();
            onSendNow(card.id);
          }
        }}
      />
    </div>
  );
}

/** With no provider the body says so once, with the one button that fixes it. It takes focus when the panel opens. */
function SetupLine({ onOpenSettings }: { onOpenSettings: () => void }) {
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    button.current?.focus();
  }, []);
  return (
    <div className="ui-ask-dock__setup">
      <p className="ui-ask-dock__setup-text">Ask needs an AI key.</p>
      <Btn ref={button} variant="text" label="Add a key" onPress={() => onOpenSettings()} />
    </div>
  );
}

/** The queued cards and the field with its Stop and Ask buttons. */
function DockFoot(props: AskDockProps & { activeOption: string | undefined; emptyId: string }) {
  const { value, onChange, onSubmit, working, onStop, queued, dictation, fieldRef } = props;
  const { providerReady } = props;
  const sendNowKeys = describeKeys('ask.sendNow');
  function onFieldKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing || event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    if (providerReady) onSubmit(event.metaKey ? 'searchAll' : 'ask');
  }
  return (
    <footer className="ui-ask-dock__foot">
      {queued.map(card => (
        <QueuedCard
          key={card.id}
          card={card}
          sendNowKeys={sendNowKeys}
          onChange={props.onQueuedChange}
          onSendNow={props.onSendQueuedNow}
        />
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
            placeholder={providerReady ? 'Ask about your mail or calendar' : 'Add a key to ask'}
            disabled={!providerReady}
            data-dictation="body"
            aria-controls={props.activeOption ? props.emptyId : undefined}
            aria-activedescendant={props.activeOption}
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
              disabled={!providerReady}
              onPress={() => onSubmit('ask')}
            />
          </span>
        </div>
        {dictation ? <DictationLine dictation={dictation} /> : null}
      </div>
    </footer>
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
  const { tab, onTabChange, onClose, width, onWidthChange, providerReady } = props;
  const { conversation, empty, today } = props;
  const baseId = useId();
  const size = clampWidth(width);
  const resize = useResize(size, onWidthChange);
  const emptyId = `${baseId}-empty`;
  const showEmpty = tab === 'ask' && providerReady && !conversation && Boolean(empty);
  const activeOption = activeOptionOf(empty, showEmpty, emptyId);

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
        onPointerDown={resize.onPointerDown}
        onPointerMove={resize.onPointerMove}
        onPointerUp={resize.onPointerUp}
        onPointerCancel={resize.onPointerUp}
        onKeyDown={resize.onKeyDown}
      />
      <DockHead baseId={baseId} tab={tab} onTabChange={onTabChange} onClose={onClose} />
      <div
        className="ui-ask-dock__body"
        role="tabpanel"
        id={`${baseId}-panel`}
        aria-labelledby={`${baseId}-tab-${tab}`}
      >
        {tab === 'today' ? today : null}
        {tab === 'ask' && providerReady && conversation ? conversation : null}
        {showEmpty && empty ? <EmptyView empty={empty} listId={emptyId} /> : null}
        {tab === 'ask' && !providerReady ? (
          <SetupLine onOpenSettings={props.onOpenSettings} />
        ) : null}
      </div>
      {tab === 'ask' ? <DockFoot {...props} activeOption={activeOption} emptyId={emptyId} /> : null}
    </aside>
  );
}
