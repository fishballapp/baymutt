import { Select as BaseSelect } from '@base-ui/react/select';
import { CaretDownIcon, CheckIcon } from '@phosphor-icons/react';
import { cn } from 'cn';
import type { ComponentProps } from 'react';
import { controlStyles } from './control.ts';

export type SelectOption<Value extends string> = {
  readonly value: Value;
  readonly label: string;
};

/** The closed select: what is chosen, and a caret. */
const SelectTrigger = ({ className, ...props }: ComponentProps<typeof BaseSelect.Trigger>) => (
  <BaseSelect.Trigger
    className={cn(
      controlStyles,
      'flex h-9 cursor-pointer items-center justify-between gap-2 pr-3 text-left data-popup-open:border-accent',
      className,
    )}
    {...props}
  >
    <BaseSelect.Value className="min-w-0 truncate" />
    <BaseSelect.Icon className="shrink-0 text-muted">
      <CaretDownIcon aria-hidden="true" className="size-3.5" />
    </BaseSelect.Icon>
  </BaseSelect.Trigger>
);

/** The open list, drawn like the page: a hairline edge, no shadow, the chosen option checked. */
const SelectPopup = <Value extends string>({
  options,
}: {
  readonly options: ReadonlyArray<SelectOption<Value>>;
}) => (
  <BaseSelect.Portal>
    <BaseSelect.Positioner
      align="start"
      alignItemWithTrigger={false}
      sideOffset={4}
      className="z-50 outline-none"
    >
      <BaseSelect.Popup className="min-w-(--anchor-width) overflow-hidden rounded-control border border-line bg-surface text-base text-foreground outline-none transition-opacity duration-150 ease-out data-ending-style:opacity-0 data-starting-style:opacity-0">
        <BaseSelect.List className="max-h-(--available-height) overflow-y-auto py-1 outline-none">
          {options.map(({ value, label }) => (
            <BaseSelect.Item
              key={value}
              value={value}
              className="grid cursor-default grid-cols-[1rem_1fr] items-center gap-2 py-2 pr-4 pl-2.5 outline-none select-none data-highlighted:bg-sunken sm:py-1.5"
            >
              <BaseSelect.ItemIndicator className="col-start-1">
                <CheckIcon aria-hidden="true" className="size-4 text-accent" />
              </BaseSelect.ItemIndicator>
              <BaseSelect.ItemText className="col-start-2">{label}</BaseSelect.ItemText>
            </BaseSelect.Item>
          ))}
        </BaseSelect.List>
      </BaseSelect.Popup>
    </BaseSelect.Positioner>
  </BaseSelect.Portal>
);

/**
 * A select, drawn like every other control: `Select.Root` takes the `options` as `items`, and
 * `Select.Popup` lists the same ones.
 */
export const Select = {
  Root: BaseSelect.Root,
  Label: BaseSelect.Label,
  Trigger: SelectTrigger,
  Popup: SelectPopup,
};
