import { Button as BaseButton } from '@base-ui/react/button';
import { cn } from 'cn';
import type { ComponentProps, ReactNode } from 'react';
import { Tooltip } from './tooltip.tsx';

/**
 * A button that is only a glyph. `label` is its accessible name and says what it holds or does
 * ("Reveal DATABASE_URL", "Migration agent: access, expiry, revoke"). `tooltip`, when given, shows
 * above it: the value and copy actions name what they do this way; `⋯` has none.
 */
export const IconButton = ({
  label,
  tooltip,
  icon,
  isCopied = false,
  className,
  type = 'button',
  ...props
}: Omit<ComponentProps<typeof BaseButton>, 'className' | 'children' | 'aria-label'> & {
  readonly label: string;
  readonly tooltip?: ReactNode;
  /** A Phosphor glyph, `aria-hidden`, with `className="gl"`. */
  readonly icon: ReactNode;
  /** Just copied: the glyph is in `accent`. */
  readonly isCopied?: boolean;
  readonly className?: string;
}) => {
  const button = (
    <BaseButton
      type={type}
      aria-label={label}
      className={cn('icon-btn', isCopied && 'copied', className)}
      {...props}
    >
      {icon}
    </BaseButton>
  );
  if (tooltip === undefined) return button;
  return <Tooltip content={tooltip}>{button}</Tooltip>;
};
