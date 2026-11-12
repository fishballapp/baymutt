import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from 'cn';
import type { ComponentProps } from 'react';

/** The button's look, for a link that is the row's action. */
export const buttonStyles = cva(
  'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-control border font-medium whitespace-nowrap transition-colors duration-150 ease-out disabled:cursor-not-allowed disabled:opacity-50',
  {
    variants: {
      intent: {
        // One per screen: the thing the owner came to do.
        primary:
          'border-accent bg-accent text-accent-foreground hover:brightness-110 active:brightness-95',
        plain: 'border-line bg-surface text-foreground hover:bg-sunken active:bg-line',
        quiet: 'border-transparent text-muted hover:bg-sunken hover:text-foreground',
        danger: 'border-line bg-surface text-danger hover:border-danger hover:bg-danger-soft',
        // A row's own actions: quiet until pointed at, so a list of rows reads as a ledger.
        subtle: 'border-transparent text-foreground hover:bg-sunken active:bg-line',
        subtleDanger: 'border-transparent text-danger hover:bg-danger-soft',
      },
      size: {
        md: 'h-9 px-3.5 text-base',
        sm: 'h-7 px-2.5 text-sm',
      },
    },
    defaultVariants: { intent: 'plain', size: 'md' },
  },
);

export const Button = ({
  intent,
  size,
  className,
  type = 'button',
  ...props
}: ComponentProps<'button'> & VariantProps<typeof buttonStyles>) => (
  <button type={type} className={cn(buttonStyles({ intent, size }), className)} {...props} />
);
