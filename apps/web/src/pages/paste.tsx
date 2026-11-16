// The page a paste link opens: one box, for one name in one environment. Only the signed-in owner
// answers it, with the vault open: the link carries nothing but its id.
import { useAtom, useAtomValue } from '@effect/atom-react';
import * as AsyncResult from 'effect/reactivity/AsyncResult';
import { useState } from 'react';
import { useOwner } from '../components/gate.tsx';
import { Code, Notice } from '../components/parts.tsx';
import { Button } from '../components/ui/button.tsx';
import { TextArea } from '../components/ui/field.tsx';
import { addressOf, fulfilPasteAtom, NAME_NOT_OPENED, pasteTargetAtom } from '../lib/data.ts';
import { failureMessage, latest } from '../lib/result.ts';

export const PastePage = ({ id }: { readonly id: string }) => {
  const owner = useOwner();
  const targetResult = useAtomValue(pasteTargetAtom(owner)(id));
  const target = latest(targetResult);
  const [saving, save] = useAtom(fulfilPasteAtom);
  const [value, setValue] = useState('');

  if (AsyncResult.isSuccess(saving)) {
    return (
      <div role="status">
        <h1 className="text-xl leading-tight">Saved</h1>
        <p className="mt-2 text-muted">
          <Code className="text-foreground">{target?.link.openedName ?? NAME_NOT_OPENED}</Code> is
          sealed as version {saving.value.currentVersion}. You can close this tab.
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

  const { link } = target;
  const isUnopened = link.openedName === null || link.openedEnvironmentName === null;
  return (
    <form
      className="space-y-6"
      onSubmit={event => {
        event.preventDefault();
        save({
          id,
          owner,
          value,
          shown: {
            environmentId: link.environmentId,
            environmentName: link.environmentName,
            environmentSealedName: link.environmentSealedName,
            openedEnvironmentName: link.openedEnvironmentName,
            name: link.name,
            sealedName: link.sealedName,
            openedName: link.openedName,
          },
        });
      }}
    >
      <div>
        <h1 className="text-xl leading-tight">
          Paste <Code className="text-xl font-[650]">{link.openedName ?? NAME_NOT_OPENED}</Code>
        </h1>
        <p className="mt-2 text-muted">
          <span className="text-foreground">{link.createdBy.name}</span> asks for it in{' '}
          <Code className="text-foreground">
            {addressOf({ orgSlug: link.orgSlug, name: link.openedEnvironmentName })}
          </Code>
          .
        </p>
      </div>
      {(link.reason !== '' || link.hint !== '') && (
        <dl className="space-y-3 rounded-control border border-line bg-sunken px-4 py-3">
          {link.reason !== '' && (
            <div>
              <dt className="text-sm text-muted">Why</dt>
              <dd>{link.reason}</dd>
            </div>
          )}
          {link.hint !== '' && (
            <div>
              <dt className="text-sm text-muted">Where to find it</dt>
              <dd>{link.hint}</dd>
            </div>
          )}
        </dl>
      )}
      {isUnopened && (
        <Notice tone="warn">
          A name on this link does not open with your vault, so nothing can be saved for it.
        </Notice>
      )}
      <TextArea
        label="Value"
        isCode
        rows={6}
        autoFocus
        hint="Sealed in this browser to the environment’s key before it is sent. baymutt cannot read it, and this page will not show it again. Several lines are fine."
        error={failureMessage(saving)}
        value={value}
        onChange={event => setValue(event.target.value)}
      />
      <Button
        type="submit"
        intent="primary"
        className="w-full sm:w-auto"
        disabled={value === '' || saving.waiting || isUnopened}
      >
        {saving.waiting ? 'Sealing…' : 'Seal and save'}
      </Button>
    </form>
  );
};
