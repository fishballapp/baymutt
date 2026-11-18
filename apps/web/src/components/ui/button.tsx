import { Button as BaseButton } from '@base-ui/react/button';
import { cn } from 'cn';
import type { ComponentProps } from 'react';

/**
 * What a button is for: `secondary` for a list's action, Review, Reject and a
 * dialog's keep; `primary` for the screen's one main action; `danger` for Delete environment;
 * `danger-fill` for an alert dialog's confirm; `quiet` and `quiet-danger` for the word-only actions
 * (Restore, Cancel, "Show 3 ended keys", the password's Remove).
 */
export type ButtonKind =
  | 'secondary'
  | 'primary'
  | 'danger'
  | 'danger-fill'
  | 'quiet'
  | 'quiet-danger';

export type ButtonLook = {
  readonly kind?: ButtonKind;
  /** `lg` on decision, entry and landing pages. Quiet buttons have one size. */
  readonly size?: 'md' | 'lg';
  /** Fills its column (entry pages). */
  readonly isWide?: boolean;
};

/** A button's classes, for an element that only looks like one: a router link to a decision page. */
export const buttonClass = ({
  kind = 'secondary',
  size = 'md',
  isWide = false,
}: ButtonLook = {}) => {
  if (kind === 'quiet') return 'quiet';
  if (kind === 'quiet-danger') return 'quiet danger';
  return cn('btn', kind !== 'secondary' && kind, size === 'lg' && 'lg', isWide && 'wide');
};

/**
 * A button that names what it does. While its action runs it shows `pendingLabel` and is disabled,
 * so a second press cannot repeat the action. A label that can outgrow the button truncates.
 */
export const Button = ({
  kind,
  size,
  isWide,
  isPending = false,
  pendingLabel,
  disabled,
  className,
  children,
  type = 'button',
  ...props
}: ButtonLook &
  Omit<ComponentProps<typeof BaseButton>, 'className'> & {
    readonly className?: string;
    /** Its action is running: it shows `pendingLabel` and takes no press. */
    readonly isPending?: boolean;
    /** What it says while running: "Approving…". */
    readonly pendingLabel?: string;
  }) => (
  <BaseButton
    type={type}
    disabled={disabled === true || isPending}
    className={cn(buttonClass({ kind, size, isWide }), className)}
    {...props}
  >
    <span className="t">{isPending && pendingLabel !== undefined ? pendingLabel : children}</span>
  </BaseButton>
);
