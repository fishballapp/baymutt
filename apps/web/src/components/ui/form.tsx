import { Form as BaseForm } from '@base-ui/react/form';
import { cn } from 'cn';
import {
  createContext,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  use,
  useState,
} from 'react';
import { Button } from './button.tsx';

const OpenForm = createContext<{
  readonly openId: string | null;
  readonly setOpenId: Dispatch<SetStateAction<string | null>>;
} | null>(null);

/**
 * Holds which inline form (or History panel) of a page is open: one at a time. The shell puts one
 * around each page, so leaving the page closes it.
 */
export const InlineFormScope = ({ children }: { readonly children: ReactNode }) => {
  const [openId, setOpenId] = useState<string | null>(null);
  return <OpenForm value={{ openId, setOpenId }}>{children}</OpenForm>;
};

/**
 * One inline form or panel of the page, by an id unique on the page ("new-environment",
 * "replace:DATABASE_URL", "history:DATABASE_URL"). Opening it closes any other.
 */
export const useInlineForm = (id: string) => {
  const scope = use(OpenForm);
  if (scope === null) throw new Error('useInlineForm needs an InlineFormScope around the page.');
  return {
    isOpen: scope.openId === id,
    /** Whether any form or panel of the page is open. */
    isAnyOpen: scope.openId !== null,
    /** Which form or panel of the page is open, by its id: a page whose head hides its primary
     * for some of them (forms, not History) reads it. */
    openId: scope.openId,
    open: () => scope.setOpenId(id),
    close: () => scope.setOpenId(current => (current === id ? null : current)),
  };
};

/**
 * A real `<form>`, so Enter submits: its fields (`children`), then `.form-acts` with the submit
 * (primary) and, when `onCancel` is given, a quiet Cancel. `placement` picks its frame:
 * - `row`: `li.form-row`, the first row of its list or straight under the row it replaces;
 * - `inline`: `.form-inline`, under a list heading with no rows to hold it (Password);
 * - `page`: `.form-page`, a page-level form (Create your first org).
 */
export const ActionForm = ({
  placement,
  label,
  submitLabel,
  pendingLabel,
  isPending = false,
  isSubmitDisabled = false,
  onSubmit,
  onCancel,
  children,
}: {
  readonly placement: 'row' | 'inline' | 'page';
  /** The form's accessible name, when its fields do not say what it makes. */
  readonly label?: string;
  readonly submitLabel: string;
  /** "Creating…", "Sealing…". */
  readonly pendingLabel: string;
  readonly isPending?: boolean;
  /** Until every field is valid. */
  readonly isSubmitDisabled?: boolean;
  readonly onSubmit: () => void;
  readonly onCancel?: () => void;
  readonly children: ReactNode;
}) => {
  const form = (
    <BaseForm
      aria-label={label}
      className={cn(
        'form',
        placement === 'inline' && 'form-inline',
        placement === 'page' && 'form-page',
      )}
      onSubmit={event => {
        event.preventDefault();
        if (!isPending && !isSubmitDisabled) onSubmit();
      }}
    >
      {children}
      <div className="form-acts">
        <Button
          type="submit"
          kind="primary"
          isPending={isPending}
          pendingLabel={pendingLabel}
          disabled={isSubmitDisabled}
        >
          {submitLabel}
        </Button>
        {onCancel && (
          <Button kind="quiet" disabled={isPending} onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </BaseForm>
  );
  if (placement !== 'row') return form;
  return <li className="form-row">{form}</li>;
};
