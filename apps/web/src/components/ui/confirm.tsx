import { AlertDialog } from '@base-ui/react/alert-dialog';
import { type ReactElement, type ReactNode, useRef } from 'react';
import { Button } from './button.tsx';

/**
 * The one way to confirm something that cannot be undone, or that lets a new party read. The way
 * out that changes nothing has focus when it opens, so Enter and Esc keep; a click outside does nothing.
 */
export const Confirm = ({
  trigger,
  title,
  children,
  keepLabel = 'Cancel',
  confirmLabel,
  pendingLabel,
  isDangerous = false,
  isPending = false,
  error,
  onConfirm,
  open,
  onOpenChange,
}: {
  readonly trigger?: ReactElement;
  readonly title: string;
  readonly children: ReactNode;
  readonly keepLabel?: string;
  readonly confirmLabel: string;
  /** What the confirm button says while it runs: "Revoking…". */
  readonly pendingLabel: string;
  readonly isDangerous?: boolean;
  readonly isPending?: boolean;
  readonly error?: string | null;
  readonly onConfirm: () => void;
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
}) => {
  const keepRef = useRef<HTMLButtonElement>(null);
  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      {trigger && <AlertDialog.Trigger render={trigger} />}
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fixed inset-0 z-50 bg-scrim transition-opacity duration-150 ease-out data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <AlertDialog.Viewport className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4">
          <AlertDialog.Popup
            initialFocus={keepRef}
            className="w-full rounded-t-panel border border-line bg-surface p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-[0_12px_40px_-12px_rgb(0_0_0/0.35)] transition-opacity duration-150 ease-out data-ending-style:opacity-0 data-starting-style:opacity-0 sm:w-[28rem] sm:rounded-panel sm:p-6"
          >
            <AlertDialog.Title className="text-md font-[650]">{title}</AlertDialog.Title>
            <AlertDialog.Description render={<div />} className="mt-2 space-y-2 text-muted">
              {children}
            </AlertDialog.Description>
            {error && (
              <p role="alert" className="mt-3 text-sm text-danger">
                {error}
              </p>
            )}
            <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <AlertDialog.Close ref={keepRef} disabled={isPending} render={<Button />}>
                {keepLabel}
              </AlertDialog.Close>
              <Button
                intent={isDangerous ? 'danger' : 'primary'}
                disabled={isPending}
                onClick={onConfirm}
              >
                {isPending ? pendingLabel : confirmLabel}
              </Button>
            </div>
          </AlertDialog.Popup>
        </AlertDialog.Viewport>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
};
