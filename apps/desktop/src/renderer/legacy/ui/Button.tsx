import { Loader2 } from '../icons';
import { cx } from './motion';
import { Keys } from './Kbd';
import { Tooltip, type TooltipProps } from './Tooltip';

export type Icon = React.ComponentType<{ size?: number; className?: string; fill?: string }>;
export type ButtonVariant =
  'primary' | 'secondary' | 'pill' | 'ghost' | 'text' | 'danger' | 'tinted';
export type ButtonSize = 'sm' | 'md' | 'lg';
const iconSize: Record<ButtonSize, number> = { sm: 14, md: 15, lg: 17 };

export function Spinner({ size = 15, className }: { size?: number; className?: string }) {
  return <Loader2 size={size} className={cx('spin ui-spinner', className)} aria-hidden="true" />;
}

type ButtonProps = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'title'> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: Icon;
  iconRight?: Icon;
  iconFill?: string;
  /** Shortcut key caps rendered after the label. */
  shortcut?: string;
  loading?: boolean;
  /** Optional hover tooltip; `title` is intentionally not supported so every hint looks the same. */
  tooltip?: Omit<TooltipProps, 'children'>;
  ref?: React.Ref<HTMLButtonElement>;
};

export function Button({
  variant = 'secondary',
  size = 'md',
  icon: IconLeft,
  iconRight: IconRight,
  iconFill,
  shortcut,
  loading,
  tooltip,
  className,
  children,
  disabled,
  type = 'button',
  ref,
  ...rest
}: ButtonProps) {
  const button = (
    <button
      ref={ref}
      type={type}
      className={cx(
        'ui-btn',
        'ui-btn-' + variant,
        'ui-btn-' + size,
        loading && 'is-loading',
        className,
      )}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? (
        <Spinner size={iconSize[size]} />
      ) : (
        IconLeft && <IconLeft size={iconSize[size]} fill={iconFill} />
      )}
      {children !== undefined && children !== null && children !== false && (
        <span className="ui-btn-label">{children}</span>
      )}
      {shortcut && <Keys combo={shortcut} size="sm" />}
      {IconRight && <IconRight size={iconSize[size] - 1} />}
    </button>
  );
  return tooltip ? <Tooltip {...tooltip}>{button}</Tooltip> : button;
}

type IconButtonProps = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'title' | 'children'> & {
  /** Accessible name; also the tooltip text unless `tooltip` is false. */
  label: string;
  icon?: Icon;
  iconFill?: string;
  iconSize?: number;
  shortcut?: string;
  detail?: React.ReactNode;
  tooltip?: boolean;
  placement?: TooltipProps['placement'];
  size?: 'xs' | 'sm' | 'md' | 'lg';
  variant?: 'plain' | 'glass' | 'round';
  active?: boolean;
  loading?: boolean;
  children?: React.ReactNode;
  ref?: React.Ref<HTMLButtonElement>;
};
const iconButtonGlyph = { xs: 13, sm: 15, md: 16, lg: 18 };

export function IconButton({
  label,
  icon: Glyph,
  iconFill,
  iconSize,
  shortcut,
  detail,
  tooltip = true,
  placement = 'bottom',
  size = 'md',
  variant = 'plain',
  active,
  loading,
  className,
  children,
  disabled,
  type = 'button',
  ref,
  ...rest
}: IconButtonProps) {
  const glyph = iconSize ?? iconButtonGlyph[size];
  const button = (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      className={cx(
        'ui-icon-btn',
        'ui-icon-btn-' + size,
        variant !== 'plain' && 'ui-icon-btn-' + variant,
        active && 'is-active',
        className,
      )}
      disabled={disabled || loading}
      aria-pressed={active === undefined ? undefined : active}
      {...rest}
    >
      {loading ? (
        <Spinner size={glyph} />
      ) : (
        (children ?? (Glyph && <Glyph size={glyph} fill={iconFill} />))
      )}
    </button>
  );
  return tooltip ? (
    <Tooltip content={label} detail={detail} shortcut={shortcut} placement={placement}>
      {button}
    </Tooltip>
  ) : (
    button
  );
}
