import { AlertDialog } from '@base-ui/react/alert-dialog';
import { Dialog as BaseDialog } from '@base-ui/react/dialog';
import { type ReactElement, type ReactNode, type RefObject, useLayoutEffect, useRef } from 'react';
import { Button } from './button.tsx';

type DialogProps = {
  /** Opens it; leave out when `open` is driven from elsewhere (a row's menu). */
  readonly trigger?: ReactElement;
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  /**
   * Runs each time it opens, by its trigger or by `open` turning true, before it paints: where a
   * dialog starts its fields and its action's result afresh, so it shows what it will save.
   */
  readonly onOpen?: () => void;
  /** The `h2`. An exact string in it is `.code`. */
  readonly title: ReactNode;
  /** `.dialog-body`: controls first, then sentences. It scrolls when the window is short. */
  readonly children: ReactNode;
  /** The action failed: shown under the body, and the dialog stays open. */
  readonly error?: string | null;
  /** The way out that changes nothing: "Cancel", "Keep key". */
  readonly keepLabel?: string;
  /** Names what it does: "Save access", "Revoke key". */
  readonly confirmLabel: string;
  /** What the confirm says while it runs: "Revoking…". */
  readonly pendingLabel: string;
  readonly isPending?: boolean;
  readonly isConfirmDisabled?: boolean;
  readonly onConfirm: () => void;
};

/**
 * `onOpen` for both kinds. Base UI reports opening only from a trigger; a dialog a row's menu opens
 * by setting `open` is seen here, as `open` turning true. The answer is the `onOpenChange` to hand
 * Base UI.
 */
const useOnOpen = ({
  open,
  onOpenChange,
  onOpen,
}: Pick<DialogProps, 'open' | 'onOpenChange' | 'onOpen'>) => {
  const wasOpen = useRef(open === true);
  useLayoutEffect(() => {
    if (open === true && !wasOpen.current) onOpen?.();
    wasOpen.current = open === true;
  }, [open, onOpen]);
  return (isOpen: boolean) => {
    // Uncontrolled, Base UI's report is the only sign it opened.
    if (isOpen && open === undefined) onOpen?.();
    onOpenChange?.(isOpen);
  };
};

/** The error and `.dialog-acts` both kinds end with: keep, then confirm. */
const Ending = ({
  keep,
  error,
  confirmKind,
  confirmLabel,
  pendingLabel,
  isPending = false,
  isConfirmDisabled = false,
  onConfirm,
}: Pick<
  DialogProps,
  'error' | 'confirmLabel' | 'pendingLabel' | 'isPending' | 'isConfirmDisabled' | 'onConfirm'
> & { readonly keep: ReactNode; readonly confirmKind: 'primary' | 'danger-fill' }) => (
  <>
    {error && (
      <p role="alert" className="error">
        {error}
      </p>
    )}
    <div className="dialog-acts">
      {keep}
      <Button
        kind={confirmKind}
        isPending={isPending}
        pendingLabel={pendingLabel}
        disabled={isConfirmDisabled}
        onClick={onConfirm}
      >
        {confirmLabel}
      </Button>
    </div>
  </>
);

/**
 * A dialog that changes something: a key's access, an expiry. Its confirm is the primary. The
 * keep button has focus when it opens, so Escape and Enter keep; a click on the scrim does nothing.
 */
export const Dialog = ({
  trigger,
  open,
  onOpenChange,
  onOpen,
  title,
  children,
  keepLabel = 'Cancel',
  ...ending
}: DialogProps) => {
  const keepRef: RefObject<HTMLButtonElement | null> = useRef(null);
  const handleOpenChange = useOnOpen({ open, onOpenChange, onOpen });
  return (
    <BaseDialog.Root open={open} onOpenChange={handleOpenChange} disablePointerDismissal>
      {trigger && <BaseDialog.Trigger render={trigger} />}
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className="scrim" />
        <BaseDialog.Viewport className="dialog-viewport">
          <BaseDialog.Popup initialFocus={keepRef} className="dialog">
            <BaseDialog.Title>{title}</BaseDialog.Title>
            <div className="dialog-body">{children}</div>
            <Ending
              confirmKind="primary"
              keep={
                <BaseDialog.Close ref={keepRef} disabled={ending.isPending} render={<Button />}>
                  {keepLabel}
                </BaseDialog.Close>
              }
              {...ending}
            />
          </BaseDialog.Popup>
        </BaseDialog.Viewport>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
};

/**
 * An alert dialog for what cannot be undone or stops something at once: revoke, delete. Its body
 * is sentences only, and its confirm is `danger-fill`. The keep button has focus when it opens.
 */
export const Confirm = ({
  trigger,
  open,
  onOpenChange,
  onOpen,
  title,
  children,
  keepLabel = 'Cancel',
  ...ending
}: DialogProps) => {
  const keepRef: RefObject<HTMLButtonElement | null> = useRef(null);
  const handleOpenChange = useOnOpen({ open, onOpenChange, onOpen });
  return (
    <AlertDialog.Root open={open} onOpenChange={handleOpenChange}>
      {trigger && <AlertDialog.Trigger render={trigger} />}
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="scrim" />
        <AlertDialog.Viewport className="dialog-viewport">
          <AlertDialog.Popup initialFocus={keepRef} className="dialog">
            <AlertDialog.Title>{title}</AlertDialog.Title>
            <AlertDialog.Description render={<div />} className="dialog-body">
              {children}
            </AlertDialog.Description>
            <Ending
              confirmKind="danger-fill"
              keep={
                <AlertDialog.Close ref={keepRef} disabled={ending.isPending} render={<Button />}>
                  {keepLabel}
                </AlertDialog.Close>
              }
              {...ending}
            />
          </AlertDialog.Popup>
        </AlertDialog.Viewport>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
};
