import { Select as BaseSelect } from '@base-ui/react/select';
import { CaretDownIcon, CheckIcon } from '@phosphor-icons/react';
import type { ReactNode } from 'react';
import { POPUP_OFFSET } from './menu.tsx';

export type SelectOption<Value extends string> = {
  readonly value: Value;
  readonly label: string;
};

/**
 * `.select` with its label. `above` is a `.field` (a dialog's Expires); `beside` is `.ends` (a
 * decision page's Ends), which on a phone puts the label above and lets a long choice wrap. The
 * popup is a portaled `.menu` at least the trigger's width, so every option shows in full, above a
 * dialog by layer.
 */
export const Select = <Value extends string>({
  label,
  labelPlacement = 'above',
  hint,
  options,
  value,
  onValueChange,
  isDisabled = false,
}: {
  readonly label: string;
  readonly labelPlacement?: 'above' | 'beside';
  /** Under an `above` select. */
  readonly hint?: ReactNode;
  readonly options: ReadonlyArray<SelectOption<Value>>;
  readonly value: Value;
  readonly onValueChange: (value: Value) => void;
  readonly isDisabled?: boolean;
}) => (
  <BaseSelect.Root
    items={options}
    value={value}
    disabled={isDisabled}
    onValueChange={chosen => {
      if (chosen !== null) onValueChange(chosen);
    }}
  >
    <div className={labelPlacement === 'above' ? 'field' : 'ends'}>
      <BaseSelect.Label className="label">{label}</BaseSelect.Label>
      <BaseSelect.Trigger className="select">
        <BaseSelect.Value />
        <BaseSelect.Icon render={<CaretDownIcon aria-hidden="true" className="gl" />} />
      </BaseSelect.Trigger>
      {labelPlacement === 'above' && hint && <p className="hint">{hint}</p>}
    </div>
    <BaseSelect.Portal>
      <BaseSelect.Positioner
        align="start"
        alignItemWithTrigger={false}
        sideOffset={POPUP_OFFSET}
        className="positioner"
      >
        <BaseSelect.Popup className="menu">
          <BaseSelect.List>
            {options.map(option => (
              <BaseSelect.Item key={option.value} value={option.value} className="menu-item">
                <span className="tick">
                  <BaseSelect.ItemIndicator>
                    <CheckIcon aria-hidden="true" className="gl" />
                  </BaseSelect.ItemIndicator>
                </span>
                <BaseSelect.ItemText className="t">{option.label}</BaseSelect.ItemText>
              </BaseSelect.Item>
            ))}
          </BaseSelect.List>
        </BaseSelect.Popup>
      </BaseSelect.Positioner>
    </BaseSelect.Portal>
  </BaseSelect.Root>
);
