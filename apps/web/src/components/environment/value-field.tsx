import { TextAreaField } from '../ui/field.tsx';

/** A secret's value as it is typed, before it is sealed: Add a secret's and Replace's field. */
export const ValueField = ({
  label,
  failure,
  value,
  onValueChange,
}: {
  readonly label: string;
  /** The store's, after a failed save. */
  readonly failure: string | null;
  readonly value: string;
  readonly onValueChange: (value: string) => void;
}) => (
  <TextAreaField
    label={label}
    hint="Sealed in this browser to the environment’s key: baymutt cannot read it."
    failure={failure}
    value={value}
    onValueChange={onValueChange}
  />
);
