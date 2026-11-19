/**
 * The shortcut sheet (`?`, DESIGN 8, mockups/shortcuts.html): ShortcutSheet over the registry's own list, so it can
 * never disagree with the real keys. Settings → Keyboard stays the place to change one.
 */
import { useMemo, useState } from 'react';
import { buildSheet } from '../commands';
import { ShortcutSheet } from '../ui/controls';
import { sheetProps } from '../ui/controls/sheetModel';
import { useShellRegistry } from './ShellRegistry';
import { closeShortcuts, useShortcutsOpen } from './store-shortcuts';

export function ShortcutsHost() {
  const open = useShortcutsOpen();
  const { registry } = useShellRegistry();
  const [query, setQuery] = useState('');
  const sheet = useMemo(() => (open ? sheetProps(buildSheet(registry)) : null), [open, registry]);
  if (!sheet) return null;
  const close = () => {
    setQuery('');
    closeShortcuts();
  };
  return (
    <ShortcutSheet
      open
      groups={sheet.groups}
      columns={sheet.columns}
      query={query}
      onQueryChange={setQuery}
      onClose={close}
    />
  );
}
