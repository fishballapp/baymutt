// The page a paste link opens: one box, for one name in one project. It works for whoever holds
// the link, signed in or not, and for the owner from the dashboard.
import { useAtom, useAtomValue } from '@effect/atom-react';
import * as AsyncResult from 'effect/reactivity/AsyncResult';
import { useMemo, useState } from 'react';
import { Code, Notice } from '../components/parts.tsx';
import { Button } from '../components/ui/button.tsx';
import { TextArea } from '../components/ui/field.tsx';
import { fulfilPasteAtom, type PasteAccess, pasteTargetAtom, resumeAtom } from '../lib/data.ts';
import { useOwnerStore } from '../lib/owner.ts';
import { failureMessage, latest } from '../lib/result.ts';

export const PastePage = ({ id }: { readonly id: string }) => {
  // The owner's kept vault opens here too; a visitor with only the link has none and needs none.
  useAtomValue(resumeAtom);
  const owner = useOwnerStore(state => state.owner);
  // `#<token>.<fingerprint>`: neither reaches the store in a URL.
  const access = useMemo((): PasteAccess => {
    const [token, fingerprint] = window.location.hash.slice(1).split('.');
    return { id, token: token === '' ? undefined : token, fingerprint };
  }, [id]);
  const targetResult = useAtomValue(pasteTargetAtom(access));
  const target = latest(targetResult);
  const [saving, save] = useAtom(fulfilPasteAtom);
  const [value, setValue] = useState('');

  if (AsyncResult.isSuccess(saving)) {
    return (
      <div role="status">
        <h1 className="text-xl leading-tight">Saved</h1>
        <p className="mt-2 text-muted">
          <Code className="text-foreground">{saving.value.name}</Code> is sealed as version{' '}
          {saving.value.currentVersion}. The service account that asked can use it now. You can
          close this tab.
        </p>
      </div>
    );
  }

  if (target === null) {
    const failure = failureMessage(
      targetResult,
      'This link could not be checked. Try again in a minute.',
    );
    return failure === null ? (
      <p className="text-muted" role="status">
        Checking the link…
      </p>
    ) : (
      <div className="space-y-4">
        <h1 className="text-xl leading-tight">This link cannot be used</h1>
        <Notice tone="warn">{failure}</Notice>
      </div>
    );
  }

  const { request } = target;
  return (
    <form
      className="space-y-6"
      onSubmit={event => {
        event.preventDefault();
        save({ access, owner, value });
      }}
    >
      <div>
        <h1 className="text-xl leading-tight">
          Paste <Code className="text-xl font-[650]">{request.name}</Code>
        </h1>
        <p className="mt-2 text-muted">
          <span className="text-foreground">{request.createdBy.name}</span> asks for it in{' '}
          <Code className="text-foreground">{request.projectName}</Code>.
        </p>
      </div>
      {(request.reason !== '' || request.hint !== '') && (
        <dl className="space-y-3 rounded-control border border-line bg-sunken px-4 py-3">
          {request.reason !== '' && (
            <div>
              <dt className="text-sm text-muted">Why</dt>
              <dd>{request.reason}</dd>
            </div>
          )}
          {request.hint !== '' && (
            <div>
              <dt className="text-sm text-muted">Where to find it</dt>
              <dd>{request.hint}</dd>
            </div>
          )}
        </dl>
      )}
      <TextArea
        label="Value"
        isCode
        rows={6}
        autoFocus
        hint="Sealed in this browser to the project’s key before it is sent. baymutt cannot read it, and this page will not show it again. Several lines are fine."
        error={failureMessage(saving)}
        value={value}
        onChange={event => setValue(event.target.value)}
      />
      <Button
        type="submit"
        intent="primary"
        className="w-full sm:w-auto"
        disabled={value === '' || saving.waiting}
      >
        {saving.waiting ? 'Sealing…' : 'Seal and save'}
      </Button>
    </form>
  );
};
