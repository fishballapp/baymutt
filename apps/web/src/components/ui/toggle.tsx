import { Toggle as BaseToggle } from '@base-ui/react/toggle';
import { ToggleGroup as BaseToggleGroup } from '@base-ui/react/toggle-group';
import type { ComponentProps } from 'react';
import { Button } from './button.tsx';

/** Buttons of which at most one is pressed; pressing it again lets go. */
export const ToggleGroup = BaseToggleGroup;

/** A row's own action that stays pressed while what it opened is showing. */
export const ToggleButton = (props: Omit<ComponentProps<typeof BaseToggle>, 'render'>) => (
  <BaseToggle render={<Button size="sm" intent="subtle" />} {...props} />
);
