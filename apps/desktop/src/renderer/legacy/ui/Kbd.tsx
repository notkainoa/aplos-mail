import { cx } from './motion';

/** A single key cap. */
export function Kbd({
  children,
  size = 'md',
  className,
}: {
  children: React.ReactNode;
  size?: 'sm' | 'md';
  className?: string;
}) {
  return <kbd className={cx('ui-kbd', size === 'sm' && 'ui-kbd-sm', className)}>{children}</kbd>;
}

/** A shortcut such as "⌘ K" or "⌃ 1"; a space separates key caps. */
export function Keys({
  combo,
  size = 'md',
  className,
}: {
  combo: string;
  size?: 'sm' | 'md';
  className?: string;
}) {
  const caps = combo.startsWith('Hold ') ? [combo] : combo.split(' ').filter(Boolean);
  return (
    <span className={cx('ui-keys', className)} aria-hidden="true">
      {caps.map((key, i) => (
        <Kbd key={i} size={size}>
          {key}
        </Kbd>
      ))}
    </span>
  );
}
