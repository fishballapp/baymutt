import { Menu as BaseMenu } from '@base-ui/react/menu';
import { CheckIcon, DotsThreeIcon } from '@phosphor-icons/react';
import { cn } from 'cn';
import type { ComponentProps, ReactNode } from 'react';
import { IconButton } from './icon-button.tsx';

/** The gap between a trigger and its popup, Base UI's `sideOffset`: menus, selects and tooltips. */
export const POPUP_OFFSET = 4;

/**
 * The portaled `.menu` under its trigger: `align` `start` for the org menu, `end` for a row's `⋯`.
 * `isOrgs` caps it narrower, so long org names truncate.
 */
const Popup = ({
  align,
  isOrgs = false,
  children,
}: {
  readonly align: 'start' | 'end';
  readonly isOrgs?: boolean;
  readonly children: ReactNode;
}) => (
  <BaseMenu.Portal>
    <BaseMenu.Positioner align={align} sideOffset={POPUP_OFFSET} className="positioner">
      <BaseMenu.Popup className={cn('menu', isOrgs && 'orgs')}>{children}</BaseMenu.Popup>
    </BaseMenu.Positioner>
  </BaseMenu.Portal>
);

/** A `.menu-item`: its `.tick` column stays empty, so labels line up with checked ones. */
const Item = ({
  isDanger = false,
  children,
  ...props
}: Omit<ComponentProps<typeof BaseMenu.Item>, 'className' | 'children'> & {
  readonly isDanger?: boolean;
  readonly children: ReactNode;
}) => (
  <BaseMenu.Item className={cn('menu-item', isDanger && 'danger')} {...props}>
    <span className="tick" />
    <span className="t">{children}</span>
  </BaseMenu.Item>
);

/** A `.menu-item` that is one of a radio group (an org): checked shows the tick. */
const RadioItem = ({
  children,
  ...props
}: Omit<ComponentProps<typeof BaseMenu.RadioItem>, 'className' | 'children'> & {
  readonly children: ReactNode;
}) => (
  <BaseMenu.RadioItem className="menu-item" {...props}>
    <span className="tick">
      <BaseMenu.RadioItemIndicator>
        <CheckIcon aria-hidden="true" className="gl" />
      </BaseMenu.RadioItemIndicator>
    </span>
    <span className="t">{children}</span>
  </BaseMenu.RadioItem>
);

/** The parts of a Base UI Menu in the stylesheet's classes, for a menu that is more than a list. */
export const Menu = {
  Root: BaseMenu.Root,
  Trigger: BaseMenu.Trigger,
  Popup,
  Item,
  RadioGroup: BaseMenu.RadioGroup,
  RadioItem,
  Separator: () => <BaseMenu.Separator className="menu-sep" />,
};

export type RowMenuItem = {
  readonly label: string;
  readonly onClick: () => void;
  /** Revoke, Delete, Remove access, Delete for good: last, after a separator. */
  readonly isDanger?: boolean;
  readonly isDisabled?: boolean;
};

/**
 * A row's `⋯`: an icon button whose name lists what it holds ("Migration agent: access, expiry,
 * revoke"), opening its items aligned to its end. Danger items go last, after one separator.
 * `isDisabled` while an action picked from it runs.
 */
export const RowMenu = ({
  label,
  items,
  isDisabled = false,
}: {
  readonly label: string;
  readonly items: ReadonlyArray<RowMenuItem>;
  readonly isDisabled?: boolean;
}) => {
  const plain = items.filter(item => item.isDanger !== true);
  const danger = items.filter(item => item.isDanger === true);
  const item = ({ label: words, onClick, isDanger, isDisabled: isItemDisabled }: RowMenuItem) => (
    <Item key={words} isDanger={isDanger} disabled={isItemDisabled} onClick={onClick}>
      {words}
    </Item>
  );
  return (
    <Menu.Root>
      <Menu.Trigger
        disabled={isDisabled}
        render={
          <IconButton label={label} icon={<DotsThreeIcon aria-hidden="true" className="gl" />} />
        }
      />
      <Popup align="end">
        {plain.map(item)}
        {plain.length > 0 && danger.length > 0 && <Menu.Separator />}
        {danger.map(item)}
      </Popup>
    </Menu.Root>
  );
};
