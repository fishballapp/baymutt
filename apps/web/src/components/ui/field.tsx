import { Checkbox as BaseCheckbox } from '@base-ui/react/checkbox';
import { Field as BaseField } from '@base-ui/react/field';
import { CheckIcon } from '@phosphor-icons/react';
import { cn } from 'cn';
import type { ComponentProps, ReactNode } from 'react';

export { Form } from '@base-ui/react/form';

type FieldFrame = {
  /** Always visible. */
  readonly label: ReactNode;
  readonly hint?: ReactNode;
  /** What is wrong with the input: shown in the hint's place and announced; the control turns
   * `danger`, and the form will not submit until it is fixed. */
  readonly error?: string | null;
  /**
   * The store's message after a failed attempt: shown and announced in the error's place, but the
   * field stays valid, so the next submit goes through as it is.
   */
  readonly failure?: string | null;
  readonly className?: string;
};

/**
 * `.field`: a label, its control (`children`, a `Field.Control` or a Base UI control), then a hint,
 * or in its place the input's error or else the store's failure. Base UI ties the label, the hint
 * and the error to the control; only the error makes it invalid.
 */
export const Field = ({
  label,
  labelClassName = 'label',
  isListItem = false,
  hint,
  error,
  failure,
  className,
  children,
}: FieldFrame & {
  /** `.line` for a field that is a line of a decision's `.grants`: its name, then what it is for. */
  readonly labelClassName?: string;
  /** The field is an `li` of a list (a value to paste on the ask page). */
  readonly isListItem?: boolean;
  readonly children: ReactNode;
}) => (
  <BaseField.Root
    invalid={Boolean(error)}
    className={cn('field', className)}
    render={isListItem ? <li /> : undefined}
  >
    <BaseField.Label className={labelClassName}>{label}</BaseField.Label>
    {children}
    {(() => {
      if (error) {
        return (
          <BaseField.Error match role="alert" className="error">
            {error}
          </BaseField.Error>
        );
      }
      if (failure) {
        return (
          <BaseField.Description role="alert" className="error">
            {failure}
          </BaseField.Description>
        );
      }
      return hint && <BaseField.Description className="hint">{hint}</BaseField.Description>;
    })()}
  </BaseField.Root>
);

type ControlProps = {
  /** Mono, for what is compared exactly: names, slugs, the recovery key. */
  readonly isCode?: boolean;
};

/** `.input` inside a `Field`. It carries `aria-invalid` from the field. */
const Input = ({
  isCode = false,
  className,
  ...props
}: ControlProps &
  Omit<ComponentProps<typeof BaseField.Control>, 'className'> & {
    readonly className?: string;
  }) => (
  <BaseField.Control
    autoComplete="off"
    spellCheck={false}
    className={cn('input', isCode && 'mono', className)}
    {...props}
  />
);

/** A mono `textarea.input` inside a `Field`: values (6 rows) and the recovery key (3 rows). */
export const TextArea = ({
  value,
  onValueChange,
  rows = 6,
  ...props
}: Omit<ComponentProps<'textarea'>, 'value' | 'onChange' | 'className'> & {
  readonly value: string;
  readonly onValueChange: (value: string) => void;
}) => (
  <BaseField.Control
    value={value}
    onValueChange={onValueChange}
    render={
      <textarea
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        rows={rows}
        className="input"
        {...props}
      />
    }
  />
);

/**
 * `.prefixed`: a fixed start the owner cannot change (`acme/`), then the input that is the field's
 * control. The box turns `danger` from the input's `aria-invalid`.
 */
export const PrefixedInput = ({
  prefix,
  ...props
}: { readonly prefix: string } & Omit<ComponentProps<typeof BaseField.Control>, 'className'>) => (
  <div className="prefixed">
    <span className="org">{prefix}</span>
    <BaseField.Control autoComplete="off" spellCheck={false} {...props} />
  </div>
);

/** A `Field` holding one `Input`: the common case. */
export const TextField = ({
  label,
  hint,
  error,
  failure,
  className,
  ...props
}: FieldFrame & ControlProps & Omit<ComponentProps<typeof BaseField.Control>, 'className'>) => (
  <Field label={label} hint={hint} error={error} failure={failure} className={className}>
    <Input {...props} />
  </Field>
);

/** A `Field` holding one `TextArea`. */
export const TextAreaField = ({
  label,
  hint,
  error,
  failure,
  className,
  ...props
}: FieldFrame & ComponentProps<typeof TextArea>) => (
  <Field label={label} hint={hint} error={error} failure={failure} className={className}>
    <TextArea {...props} />
  </Field>
);

/**
 * `.check`: the box, then its words, all one Base UI `Checkbox.Root`, so the whole line is the
 * target and its words are its name. A label that wraps keeps the box beside its first line.
 */
export const Checkbox = ({
  label,
  ...props
}: Omit<BaseCheckbox.Root.Props, 'className' | 'children' | 'render'> & {
  readonly label: ReactNode;
}) => (
  <BaseCheckbox.Root className="check" {...props}>
    <span className="box">
      <BaseCheckbox.Indicator>
        <CheckIcon aria-hidden="true" className="gl" weight="bold" />
      </BaseCheckbox.Indicator>
    </span>
    <span>{label}</span>
  </BaseCheckbox.Root>
);
