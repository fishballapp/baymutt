import { Collapsible as BaseCollapsible } from '@base-ui/react/collapsible';
import type { ComponentProps } from 'react';
import { Button } from './button.tsx';

/** Hides a panel behind a quiet button: `Collapsible.Root` holds the open state. */
export const Collapsible = {
  Root: BaseCollapsible.Root,
  Trigger: (props: Omit<ComponentProps<typeof BaseCollapsible.Trigger>, 'render'>) => (
    <BaseCollapsible.Trigger render={<Button size="sm" intent="quiet" />} {...props} />
  ),
  Panel: BaseCollapsible.Panel,
};
