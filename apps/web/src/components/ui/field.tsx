import { CaretDownIcon } from '@phosphor-icons/react';
import { cn } from 'cn';
import { type ComponentProps, type ReactNode, useId } from 'react';

const control =
  'w-full rounded-control border border-line bg-surface px-3 text-base text-foreground placeholder:text-muted transition-colors duration-150 hover:border-muted focus:border-accent focus:outline-none focus-visible:outline-none focus:ring-2 focus:ring-accent/30 disabled:opacity-50';

type FieldProps = {
  readonly label: string;
  readonly hint?: ReactNode;
  /** Shown in place of the hint, and announced. */
  readonly error?: string | null;
  /** For what a service account reads and a person compares: names, keys. */
  readonly isCode?: boolean;
};

const Frame = ({
  id,
  label,
  hint,
  error,
  children,
}: FieldProps & { readonly id: string; readonly children: ReactNode }) => (
  <div className="flex flex-col gap-1.5">
    <label htmlFor={id} className="text-sm font-medium">
      {label}
    </label>
    {children}
    {error ? (
      <p id={`${id}-note`} role="alert" className="text-sm text-danger">
        {error}
      </p>
    ) : (
      hint && (
        <p id={`${id}-note`} className="text-sm text-muted">
          {hint}
        </p>
      )
    )}
  </div>
);

export const TextField = ({
  label,
  hint,
  error,
  isCode,
  action,
  className,
  ...props
}: FieldProps & {
  /** A button that acts on this one field, beside it, so the hint below never moves it. */
  readonly action?: ReactNode;
} & ComponentProps<'input'>) => {
  const id = useId();
  const input = (
    <input
      id={id}
      aria-describedby={hint || error ? `${id}-note` : undefined}
      aria-invalid={error ? true : undefined}
      autoComplete="off"
      spellCheck={false}
      className={cn(control, 'h-9', isCode && 'font-mono text-sm', className)}
      {...props}
    />
  );
  return (
    <Frame id={id} label={label} hint={hint} error={error}>
      {action ? (
        <div className="flex gap-2">
          <div className="min-w-0 flex-1">{input}</div>
          {action}
        </div>
      ) : (
        input
      )}
    </Frame>
  );
};

/** The platform's own select, drawn like every other control. */
export const SelectField = ({
  label,
  hint,
  error,
  className,
  ...props
}: FieldProps & ComponentProps<'select'>) => {
  const id = useId();
  return (
    <Frame id={id} label={label} hint={hint} error={error}>
      <div className="relative">
        <select
          id={id}
          aria-describedby={hint || error ? `${id}-note` : undefined}
          aria-invalid={error ? true : undefined}
          className={cn(control, 'h-9 cursor-pointer appearance-none pr-9', className)}
          {...props}
        />
        <CaretDownIcon
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 right-3 size-3.5 -translate-y-1/2 text-muted"
        />
      </div>
    </Frame>
  );
};

export const TextArea = ({
  label,
  hint,
  error,
  isCode,
  className,
  ...props
}: FieldProps & ComponentProps<'textarea'>) => {
  const id = useId();
  return (
    <Frame id={id} label={label} hint={hint} error={error}>
      <textarea
        id={id}
        aria-describedby={hint || error ? `${id}-note` : undefined}
        aria-invalid={error ? true : undefined}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        className={cn(control, 'min-h-24 resize-y py-2', isCode && 'font-mono text-sm', className)}
        {...props}
      />
    </Frame>
  );
};
