// Demo-data helpers shared by the gallery scenes.

import type { ReactElement, ReactNode } from 'react';
import type { ListRowProps } from '../../../apps/desktop/src/renderer/ui/props';

export const noop = () => {};

const HOVER_ACTIONS = [
  { commandId: 'mail.later', icon: 'clock', label: 'Later' },
  { commandId: 'mail.done', icon: 'check', label: 'Done' },
] as const;

export function row(over: Partial<ListRowProps> & Pick<ListRowProps, 'id'>): ListRowProps {
  return {
    layout: 'list',
    density: 'comfortable',
    sender: 'Leah Okafor',
    primary: 'Lunch for six tomorrow',
    unread: false,
    date: '2026-10-27T09:30:00-07:00',
    cursor: false,
    picked: false,
    picking: false,
    hoverActions: HOVER_ACTIONS,
    onSelect: noop,
    onOpen: noop,
    onAction: noop,
    ...over,
  };
}

export function Column({
  width,
  children,
}: {
  width?: 'reader' | 'narrow' | 'full';
  children: ReactNode;
}): ReactElement {
  return (
    <div className="stage__column" data-width={width}>
      {children}
    </div>
  );
}
