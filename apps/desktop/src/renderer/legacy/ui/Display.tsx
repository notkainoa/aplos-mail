import { useRef } from 'react';
import { avatarColor } from '../bridge';
import type { Icon } from './Button';
import { cx } from './motion';

export function Avatar({
  name,
  seed,
  color,
  size = 28,
  className,
}: {
  name: string;
  seed?: string;
  color?: string;
  size?: number;
  className?: string;
}) {
  const initial = (name.trim()[0] || '?').toUpperCase();
  return (
    <span
      className={cx('ui-avatar', className)}
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.5),
        background: color ?? avatarColor(seed || name),
      }}
    >
      {initial}
    </span>
  );
}

export type Tone = 'neutral' | 'blue' | 'green' | 'red' | 'amber';
export function Badge({
  tone = 'neutral',
  icon: BadgeIcon,
  children,
  className,
  title,
}: {
  tone?: Tone;
  icon?: Icon;
  children: React.ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span className={cx('ui-badge', 'ui-badge-' + tone, className)} title={title}>
      {BadgeIcon && <BadgeIcon size={11} />}
      <span>{children}</span>
    </span>
  );
}

/** A number that pops softly when it changes. */
export function Count({ value, className }: { value: number; className?: string }) {
  const first = useRef(value);
  return (
    <span className={cx('ui-count', first.current !== value && 'is-changed', className)}>
      <span key={value}>{value}</span>
    </span>
  );
}

export function Skeleton({
  width,
  height = 12,
  radius,
  className,
}: {
  width?: number | string;
  height?: number;
  radius?: number;
  className?: string;
}) {
  return (
    <i
      className={cx('ui-skeleton', className)}
      aria-hidden="true"
      style={{ width, height, borderRadius: radius }}
    />
  );
}

export function EmptyState({
  icon: EmptyIcon,
  title,
  detail,
  action,
  compact,
  className,
}: {
  icon?: Icon;
  title: string;
  detail?: React.ReactNode;
  action?: React.ReactNode;
  compact?: boolean;
  className?: string;
}) {
  return (
    <div className={cx('ui-empty', compact && 'is-compact', className)}>
      {EmptyIcon && (
        <span className="ui-empty-icon">
          <EmptyIcon size={compact ? 20 : 24} />
        </span>
      )}
      <strong>{title}</strong>
      {detail && <p>{detail}</p>}
      {action && <div className="ui-empty-action">{action}</div>}
    </div>
  );
}

/** A titled group of rows on a card, as used by Settings. */
export function Group({
  title,
  children,
  className,
  action,
}: {
  title?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  action?: React.ReactNode;
}) {
  return (
    <section className={cx('ui-group', className)}>
      {(title || action) && (
        <header>
          {title && <h2>{title}</h2>}
          {action}
        </header>
      )}
      <div className="ui-group-card">{children}</div>
    </section>
  );
}

export function GroupRow({
  label,
  description,
  children,
  className,
}: {
  label: React.ReactNode;
  description?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cx('ui-group-row', className)}>
      <div className="ui-group-text">
        <span>{label}</span>
        {description && <p>{description}</p>}
      </div>
      {children !== undefined && <div className="ui-group-control">{children}</div>}
    </div>
  );
}

export function Notice({
  tone = 'red',
  children,
  action,
  className,
}: {
  tone?: Tone;
  children: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cx('ui-notice', 'ui-notice-' + tone, className)}
      role={tone === 'red' ? 'alert' : 'status'}
    >
      <span>{children}</span>
      {action}
    </div>
  );
}
