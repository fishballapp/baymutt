import { Checkbox as BaseCheckbox } from '@base-ui/react/checkbox';
import { Field } from '@base-ui/react/field';
import { CheckIcon } from '@phosphor-icons/react';
import { cn } from 'cn';
import type { ReactNode } from 'react';

/** A checkbox with its words beside it; the whole line is the target. `className` is for the line. */
export const Checkbox = ({
  label,
  className,
  disabled,
  ...props
}: Omit<BaseCheckbox.Root.Props, 'className' | 'children' | 'render'> & {
  readonly label: ReactNode;
  readonly className?: string;
}) => (
  <Field.Root disabled={disabled}>
    <Field.Label
      className={cn(
        'flex items-center gap-1.5 text-sm text-foreground data-disabled:text-muted',
        className,
      )}
    >
      <BaseCheckbox.Root
        className="flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-sm border border-line bg-surface text-accent-foreground transition-colors duration-150 ease-out hover:border-muted data-checked:border-accent data-checked:bg-accent data-disabled:cursor-not-allowed data-disabled:opacity-50"
        {...props}
      >
        <BaseCheckbox.Indicator>
          <CheckIcon aria-hidden="true" weight="bold" className="size-3" />
        </BaseCheckbox.Indicator>
      </BaseCheckbox.Root>
      {label}
    </Field.Label>
  </Field.Root>
);
