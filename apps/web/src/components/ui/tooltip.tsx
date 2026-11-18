import { Tooltip as BaseTooltip } from '@base-ui/react/tooltip';
import type { ReactElement, ReactNode } from 'react';
import { POPUP_OFFSET } from './menu.tsx';

/** Hover opens a tooltip after this long; keyboard focus opens it at once. */
const HOVER_DELAY_MS = 600;

/** Every tooltip in the app shares one delay group: it sits once around the app. */
export const TooltipProvider = ({ children }: { readonly children: ReactNode }) => (
  <BaseTooltip.Provider delay={HOVER_DELAY_MS}>{children}</BaseTooltip.Provider>
);

/**
 * Words above a focusable control (`children`, one element). `content` null shows none, so a
 * control can carry a tooltip only while it needs one (a truncated name).
 */
export const Tooltip = ({
  content,
  children,
}: {
  readonly content: ReactNode;
  readonly children: ReactElement;
}) => {
  if (content === null) return children;
  return (
    <BaseTooltip.Root>
      <BaseTooltip.Trigger render={children} />
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner side="top" sideOffset={POPUP_OFFSET} className="positioner tip">
          <BaseTooltip.Popup className="tooltip">{content}</BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  );
};
