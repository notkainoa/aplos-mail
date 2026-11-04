/**
 * The few pieces every Settings section shares, all composed from `renderer/ui` (nothing here styles a control):
 * `Row` (a SettingRow with its palette anchor), `Anchor` (the same anchor around a composite block such as a
 * provider row), `Group` (a section label and its rows), `Select` (the frozen picker: a Button that opens a Menu with
 * the current choice checked) and `NotAvailable` (a row behind a capability flag that is off).
 */
import { useId, useRef, useState, type ReactNode } from 'react';
import { settingId, type SettingSection } from '../../commands';
import { Button } from '../../ui/buttons-keys';
import { SectionHeader } from '../../ui/list';
import { Menu } from '../../ui/surfaces';
import { SettingRow } from '../../ui/settings';
import type { CommandAction, SettingRowProps } from '../../ui/props';
import { NOT_AVAILABLE, type Option } from './settings.model';
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

/** A SettingRow that carries its palette anchor: ⌘K scrolls to it and focuses its control (DESIGN 7.10). */
export function Row({ section, anchor, label, control, idSuffix, ...rest }: RowProps) {
  const id = idSuffix ? `${rowId(section, anchor)}-${idSuffix}` : rowId(section, anchor);
  return (
    <div className="settings-anchor" data-setting-anchor={anchor} data-setting-section={section}>
      <SettingRow
        {...rest}
        id={id}
        label={label ?? rowSpec(section, anchor)?.label ?? anchor}
        paletteId={settingId(section, anchor)}
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
  return <Row section={section} anchor={anchor} label={label} description={NOT_AVAILABLE} />;
}

/**
 * The picker: a Button that opens a Menu with the current choice checked (`menuitemradio`). There is no listbox
 * popup in the design system. Arrow keys, Return and Esc are the Menu's own.
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
  /** The accessible name of the group the picker belongs to ("Theme"). */
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
  return (
    <>
      <Button
        ref={ref}
        id={id}
        variant="text"
        label={current?.label ?? value}
        trailingIcon="chevron-down"
        disabled={disabled}
        disabledReason={disabledReason}
        popup={{ kind: 'menu', expanded: anchor !== null, controls: menuId }}
        onPress={() => {
          setActive(value);
          setAnchor(ref.current);
        }}
      />
      <Menu
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
