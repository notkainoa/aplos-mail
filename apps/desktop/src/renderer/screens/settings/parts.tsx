/**
 * The few pieces every Settings section shares, all composed from `renderer/ui` (nothing here styles a control):
 * `Row` (a SettingRow with its palette anchor), `Anchor` (the same anchor around a composite block such as a
 * provider row), `Group` (a section label and its rows), `Select` (the frozen picker: a Button that opens a Menu with
 * the current choice checked) and `NotAvailable` (a row behind a capability flag that is off).
 */
import { useId, useRef, useState, type ReactNode } from 'react';
import { settingId, type SettingSection } from '../../commands';
import { Button, Icon, Tooltip } from '../../ui/buttons-keys';
import { ErrorLine, SectionHeader } from '../../ui/list';
import { Menu, Text } from '../../ui/surfaces';
import { SettingRow } from '../../ui/settings';
import type { CommandAction, ErrorLineKind, SettingRowProps } from '../../ui/props';
import type { WriteFailure } from './ports';
import { hiddenUntilBuilt, NOT_AVAILABLE, type Option } from './settings.model';
import { rowSpec } from './paletteEntries';

/** The DOM id of a row's label, which its control names itself by. */
export const rowId = (section: SettingSection, anchor: string): string =>
  `set-${section}-${anchor}`;

type RowProps = Omit<SettingRowProps, 'id' | 'label' | 'control' | 'paletteId'> & {
  readonly section: SettingSection;
  readonly anchor: string;
  /** Defaults to the palette entry's label. */
  readonly label?: string;
  /** For several rows under one anchor (one per connected tool): keeps their DOM ids apart. */
  readonly idSuffix?: string;
  /** A function gets the label's DOM id, for `labelledBy`. */
  readonly control?: ReactNode | ((labelId: string) => ReactNode);
};

/** A SettingRow that carries its palette anchor: ⌘K scrolls to it and focuses its control (DESIGN 7.10).
 * `tabIndex={-1}` lets the screen hand the row the focus a removed control dropped (DESIGN 11.2). */
export function Row({ section, anchor, label, control, idSuffix, ...rest }: RowProps) {
  const id = idSuffix ? `${rowId(section, anchor)}-${idSuffix}` : rowId(section, anchor);
  return (
    <div
      className="settings-anchor"
      data-setting-anchor={anchor}
      data-setting-section={section}
      tabIndex={-1}
    >
      <SettingRow
        {...rest}
        id={id}
        label={label ?? rowSpec(section, anchor)?.label ?? anchor}
        // One anchor lives on several rows (an account each): only a single-instance row may take the
        // anchor's DOM id, else the page would carry duplicates.
        paletteId={idSuffix ? undefined : settingId(section, anchor)}
        control={typeof control === 'function' ? control(id) : control}
      />
    </div>
  );
}

/** The same palette anchor around a block that is not a SettingRow (a provider row, a key list). */
export function Anchor({
  section,
  anchor,
  children,
}: {
  section: SettingSection;
  anchor: string;
  children: ReactNode;
}) {
  return (
    <div className="settings-anchor" data-setting-anchor={anchor} data-setting-section={section}>
      {children}
    </div>
  );
}

/** A group: a quiet label (never a page title), then its rows. Groups sit 32 px apart. */
export function Group({
  id,
  label,
  action,
  children,
}: {
  id: string;
  label: string;
  action?: CommandAction;
  children: ReactNode;
}) {
  return (
    <section className="settings-group" aria-labelledby={id}>
      <SectionHeader id={id} label={label} variant="section" action={action} />
      {children}
    </section>
  );
}

/** A row whose feature is not built yet: its words and "Not available yet", and no dead control. */
export function NotAvailable({
  section,
  anchor,
  label,
}: {
  section: SettingSection;
  anchor: string;
  label?: string;
}) {
  if (hiddenUntilBuilt(section, anchor)) return null;
  return <Row section={section} anchor={anchor} label={label} description={NOT_AVAILABLE} />;
}

/** A short word between two pickers in one row ("for", "up to"). The pickers' names already say it, so it is silent. */
export function InlineLabel({ children }: { children: string }) {
  return (
    <span className="settings-inline-label" aria-hidden="true">
      {children}
    </span>
  );
}

/**
 * The picker: a text button that opens a Menu with the current choice checked (`menuitemradio`). There is no
 * listbox popup in the design system. Arrow keys, Return and Esc are the Menu's own. The trigger is drawn as a
 * Button (`ui-button`, same classes) rather than being one, so its accessible name can carry the row label
 * ("Undo send: 8 seconds"); a pressed trigger also closes its menu.
 */
export function Select({
  label,
  options,
  value,
  onChange,
  disabled,
  disabledReason,
  id,
}: {
  /** The setting's name; the trigger's accessible name is "<label>: <current choice>". */
  label: string;
  options: readonly Option[];
  value: string;
  onChange(id: string): void;
  disabled?: boolean;
  disabledReason?: string;
  id?: string;
}) {
  const ref = useRef<HTMLButtonElement | null>(null);
  const menuId = useId();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [active, setActive] = useState<string | undefined>(undefined);
  const current = options.find(o => o.id === value);
  const explained = disabled === true && Boolean(disabledReason);
  const trigger = (
    <button
      ref={ref}
      id={id}
      type="button"
      className="ui-button"
      data-variant="text"
      data-size="md"
      data-tone="default"
      data-state={disabled ? 'disabled' : undefined}
      data-labelled="true"
      aria-label={`${label}: ${current?.label ?? value}`}
      disabled={disabled && !explained}
      aria-disabled={explained ? true : undefined}
      aria-haspopup="menu"
      aria-expanded={anchor !== null}
      aria-controls={menuId}
      onClick={() => {
        if (disabled) return;
        setActive(value);
        setAnchor(a => (a ? null : ref.current));
      }}
    >
      <span className="ui-button-label">{current?.label ?? value}</span>
      <Icon name="chevron-down" size="xs" />
    </button>
  );
  return (
    <>
      {explained ? (
        <Tooltip label={label} detail={disabledReason}>
          {trigger}
        </Tooltip>
      ) : (
        trigger
      )}
      <Menu
        id={menuId}
        open={anchor !== null}
        anchor={anchor}
        label={label}
        entries={options.map(o => ({ kind: 'item', id: o.id, label: o.label }))}
        checkedId={value}
        activeId={active}
        numbered={options.length <= 9}
        onActiveChange={setActive}
        onSelect={next => {
          if (next !== value) onChange(next);
        }}
        onClose={() => setAnchor(null)}
      />
    </>
  );
}

/**
 * A rejected write: one tinted line holding the ErrorLine's words and Retry plus Dismiss; it must not follow the
 * owner around. On the page it sits above the nav and the column (`.settings-failure-row` keeps it level with the
 * column); inside the diagnostics dialog it is one report row.
 */
export function FailureLine({ failure }: { failure: WriteFailure }) {
  // A failure with its own sentence, or one a Retry could double, draws as a reason line; the plain
  // rejected write keeps "Couldn't <op>." with Retry.
  const kind: ErrorLineKind =
    failure.line !== undefined || failure.retry === undefined
      ? {
          kind: 'reason',
          text: failure.line ?? `Couldn’t ${failure.op}.`,
          retryable: failure.retry !== undefined,
        }
      : { kind: 'writeRejected', op: failure.op };
  return (
    <div className="settings-failure">
      <ErrorLine
        {...kind}
        placement="settings"
        onAction={action => (action === 'retry' ? failure.retry?.() : failure.dismiss())}
      />
      <Button variant="text" size="sm" label="Dismiss" onPress={() => failure.dismiss()} />
    </div>
  );
}

/** One quiet line for a ⌘K deep link whose row is conditional and not drawn in the current state. */
export function MissingAnchor({ section, anchor }: { section: SettingSection; anchor: string }) {
  return (
    <div className="settings-anchor-miss" role="status">
      <Text variant="small" tone="dim">
        {`“${rowSpec(section, anchor)?.label ?? anchor}” is not shown in this state.`}
      </Text>
    </div>
  );
}
