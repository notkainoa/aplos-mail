/**
 * "Try the keys while you wait" (DESIGN 7.12; onboarding-drill.html step1, step3, done). The practice letters are a
 * real ListBox of ListRows whose cursor letter opens as the Home focus letter, with invented values and no data calls.
 * Each step names its keys with keycaps from the registry. Keys reach the drill through the registry's `drill` context
 * (`data-keyctx`); the buttons on the letter are their pointer duplicates.
 */
import { useId, type JSX } from 'react';
import { createAppRegistry, formatBinding, type Registry } from '../../commands';
import { toIsoDateTime } from '../../data';
import { Kbd } from '../../ui/buttons-keys';
import { FocusLetter, FocusSlot, ListBox, ListRow } from '../../ui/list';
import type { TriageCommands } from '../../ui/props';
import { Text } from '../../ui/surfaces';
import {
  DRILL_COPY,
  DRILL_LIST_ID,
  DRILL_STEPS,
  drillCount,
  drillLetter,
  type DrillKey,
  type DrillState,
} from './drill.model';

let fallback: Registry | undefined;
/**
 * The first key of a command, as its keycap ("J", "Space"). The container's configured registry is what the
 * drill resolves against, so an owner's remap (J → X) shows X; the shared default covers the preview.
 */
function capOf(registry: Registry | undefined, id: string): string {
  const reg = registry ?? (fallback ??= createAppRegistry());
  const binding = reg.keysFor(id, ['onboarding', 'firstSync', 'drill'])[0];
  return binding ? formatBinding(binding) : '';
}

const COMMANDS: TriageCommands = {
  suggest: 'drill.suggested',
  later: 'mail.later',
  done: 'drill.done',
  more: 'list.more',
};

const HOUR = 3_600_000;

export interface DrillProps {
  readonly state: DrillState;
  /** Epoch ms, for the letters' dates. */
  readonly now: number;
  /** The registry the drill resolves against, so keycaps match the owner's remaps. */
  readonly registry?: Registry;
  /** A pointer duplicate of a drill key (the letter's buttons). */
  readonly onKey: (key: DrillKey) => void;
  /** A row was clicked: move the cursor there. */
  readonly onPick: (index: number) => void;
}

export function Drill({ state, now, registry, onKey, onPick }: DrillProps) {
  const uid = useId();
  const headId = `${uid}-head`;
  const listId = DRILL_LIST_ID;
  const optionId = (id: string) => `${uid}-${id}`;
  const finished = state.step >= 4;
  const current = state.ids[state.cursor];
  const step = DRILL_STEPS[Math.min(state.step, DRILL_STEPS.length - 1)];

  const prompt = finished ? (
    <div className="fs-drill__prompt">
      <Text variant="small" as="span" tone="ink" icon="check">
        {DRILL_COPY.finished}
      </Text>
    </div>
  ) : (
    <div className="fs-drill__prompt">
      <span className="fs-drill__keys">
        {step.commands.map(id => (
          <Kbd key={id} chord={capOf(registry, id)} />
        ))}
      </span>
      <span className="fs-drill__say">
        <Text variant="small" as="span" tone="ink">
          {step.say}
        </Text>
        <Text variant="small" as="span">
          {step.sub}
        </Text>
      </span>
      <span className="fs-drill__count">
        <Text variant="small" as="span">
          {drillCount(state)}
        </Text>
      </span>
    </div>
  );

  const card = (key: string, letterId: string): JSX.Element => {
    const letter = drillLetter(letterId);
    const date = toIsoDateTime(now - letter.hoursAgo * HOUR);
    return (
      <FocusSlot key={key} density="compact">
        <FocusLetter
          id={optionId(letterId)}
          sender={letter.sender}
          date={date}
          summary={{
            state: 'ready',
            text: letter.summary,
            subject: letter.subject,
            provenance: { provider: 'Aplos', local: true },
          }}
          suggestion={{
            verb: letter.suggestion.verb,
            icon: letter.suggestion.icon,
            isDone: false,
          }}
          commands={COMMANDS}
          demoted={finished}
          onSuggestion={() => onKey('suggested')}
          onLater={() => undefined}
          onDone={() => onKey('done')}
          onMore={() => undefined}
        />
      </FocusSlot>
    );
  };

  const row = (letterId: string, index: number, cursor: boolean): JSX.Element => {
    const letter = drillLetter(letterId);
    const date = toIsoDateTime(now - letter.hoursAgo * HOUR);
    return (
      <ListRow
        key={letterId}
        id={optionId(letterId)}
        layout="home"
        density="compact"
        sender={letter.sender}
        primary={letter.subject}
        unread
        date={date}
        cursor={cursor}
        picked={false}
        picking={false}
        hoverActions={[]}
        onSelect={() => onPick(index)}
        onOpen={() => onPick(index)}
        onAction={() => undefined}
      />
    );
  };

  return (
    <section className="fs-drill" aria-labelledby={headId} data-keyctx="drill">
      <div className="fs-drill__head">
        <Text variant="title" as="h2" id={headId}>
          {DRILL_COPY.heading}
        </Text>
        <Text variant="small" as="span">
          {DRILL_COPY.sub}
        </Text>
      </div>

      {state.ran && !finished ? (
        <Text variant="small" as="p" tone="ink-2" icon="check">
          {DRILL_COPY.ran}
        </Text>
      ) : null}

      {/* The current step's keys stay under the head: the instruction must be visible at 640 × 600, and the
          mockup's prompt-under-card order loses it below the fold with the real FocusLetter (hill-climb 'a'). */}
      {prompt}
      <div className="fs-drill__list">
        <ListBox
          binding={{
            id: listId,
            label: DRILL_COPY.listLabel,
            activeDescendantId: current ? optionId(current) : undefined,
          }}
        >
          {state.ids.map((id, index) =>
            index === state.cursor ? card(id, id) : row(id, index, false),
          )}
        </ListBox>
      </div>
    </section>
  );
}
