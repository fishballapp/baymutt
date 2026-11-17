import { Field } from '@base-ui/react/field';
import { cn } from 'cn';
import type { ComponentProps, ReactNode } from 'react';
import { controlStyles } from './control.ts';
import { Select, type SelectOption } from './select.tsx';

export { Form } from '@base-ui/react/form';

type FieldProps = {
  readonly label: string;
  readonly hint?: ReactNode;
  /** Shown in place of the hint, and announced. */
  readonly error?: string | null;
  /** For what a service account reads and a person compares: names, keys. */
  readonly isCode?: boolean;
};

/** A field's hint, or its error in the hint's place: Base UI links each to its control. */
const Note = ({ hint, error }: Pick<FieldProps, 'hint' | 'error'>) => {
  if (error) {
    return (
      <Field.Error match role="alert" className="text-sm text-danger">
        {error}
      </Field.Error>
    );
  }
  return hint && <Field.Description className="text-sm text-muted">{hint}</Field.Description>;
};

const Frame = ({
  error,
  children,
}: Pick<FieldProps, 'error'> & { readonly children: ReactNode }) => (
  <Field.Root invalid={Boolean(error)} className="flex flex-col gap-1.5">
    {children}
  </Field.Root>
);

const Label = ({ children }: { readonly children: string }) => (
  <Field.Label className="text-sm font-medium">{children}</Field.Label>
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
} & ComponentProps<typeof Field.Control>) => {
  const input = (
    <Field.Control
      autoComplete="off"
      spellCheck={false}
      className={cn(controlStyles, 'h-9', isCode && 'font-mono text-sm', className)}
      {...props}
    />
  );
  return (
    <Frame error={error}>
      <Label>{label}</Label>
      {action ? (
        <div className="flex gap-2">
          <div className="min-w-0 flex-1">{input}</div>
          {action}
        </div>
      ) : (
        input
      )}
      <Note hint={hint} error={error} />
    </Frame>
  );
};

/** A select in a field: `options` are what it offers, `value` the one chosen. */
export const SelectField = <Value extends string>({
  label,
  hint,
  error,
  options,
  value,
  onValueChange,
  className,
}: Omit<FieldProps, 'isCode'> & {
  readonly options: ReadonlyArray<SelectOption<Value>>;
  readonly value: Value;
  readonly onValueChange: (value: Value) => void;
  readonly className?: string;
}) => (
  <Frame error={error}>
    <Select.Root
      items={options}
      value={value}
      onValueChange={chosen => {
        if (chosen !== null) onValueChange(chosen);
      }}
    >
      <Select.Label className="text-sm font-medium">{label}</Select.Label>
      <Select.Trigger className={className} />
      <Select.Popup options={options} />
    </Select.Root>
    <Note hint={hint} error={error} />
  </Frame>
);

export const TextArea = ({
  label,
  hint,
  error,
  isCode,
  className,
  value,
  onValueChange,
  ...props
}: FieldProps &
  Omit<ComponentProps<'textarea'>, 'value' | 'onChange'> & {
    readonly value: string;
    readonly onValueChange: (value: string) => void;
  }) => (
  <Frame error={error}>
    <Label>{label}</Label>
    <Field.Control
      value={value}
      onValueChange={onValueChange}
      render={
        <textarea
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          className={cn(
            controlStyles,
            'min-h-24 resize-y py-2',
            isCode && 'font-mono text-sm',
            className,
          )}
          {...props}
        />
      }
    />
    <Note hint={hint} error={error} />
  </Frame>
);
