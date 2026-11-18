// The page a paste link opens: one box, for one name in one environment. Only the signed-in owner
// answers it, with the vault open: the link carries nothing but its id. It sits outside the shell,
// so it draws its own decision bar, which knows the org only once the link resolves.
import { useAtom, useAtomValue } from '@effect/atom-react';
import * as AsyncResult from 'effect/reactivity/AsyncResult';
import { type ReactNode, useState } from 'react';
import { DecisionColumn, Outcome } from '../components/decision/frame.tsx';
import { Answer } from '../components/decision/parts.tsx';
import { useOwner } from '../components/gate.tsx';
import { DecisionBar, useTitle } from '../components/shell.tsx';
import { Button } from '../components/ui/button.tsx';
import { Form, TextAreaField } from '../components/ui/field.tsx';
import { Address, Code, SealedName } from '../components/ui/text.tsx';
import { fulfilPasteAtom, NAME_NOT_OPENED, orgsAtom, pasteTargetAtom } from '../lib/data.ts';
import { clearsFailure, failureMessage, latest } from '../lib/result.ts';

export const PastePage = ({ id }: { readonly id: string }) => {
  const owner = useOwner();
  const targetResult = useAtomValue(pasteTargetAtom(owner)(id));
  const target = latest(targetResult);
  const [saving, save] = useAtom(fulfilPasteAtom(id));
  const clearing = clearsFailure(saving, save);
  const [value, setValue] = useState('');
  const org = latest(useAtomValue(orgsAtom))?.find(listed => listed.id === target?.link.orgId);

  const screen = ((): { readonly title: string; readonly body: ReactNode } => {
    if (target === null) {
      const failure = failureMessage(
        targetResult,
        'This link could not be checked. Try again in a minute.',
      );
      return {
        title: 'Paste link',
        body:
          failure === null ? (
            <DecisionColumn>
              <p className="muted" role="status">
                Checking the link…
              </p>
            </DecisionColumn>
          ) : (
            <Outcome title="This link cannot be used" tone="warn">
              {failure}
            </Outcome>
          ),
      };
    }
    const { link } = target;
    if (AsyncResult.isSuccess(saving)) {
      return {
        title: 'Saved',
        body: (
          <Outcome title="Saved">
            <Code>{link.openedName ?? NAME_NOT_OPENED}</Code> is sealed as version{' '}
            {saving.value.currentVersion}. You can close this tab.
          </Outcome>
        ),
      };
    }
    const isBlocked = link.openedName === null || link.openedEnvironmentName === null;
    return {
      title: `Paste ${link.openedName ?? NAME_NOT_OPENED}`,
      body: (
        <DecisionColumn>
          <p className="ask">
            <b>{link.createdBy.name}</b> asks for it in{' '}
            <Address orgSlug={link.orgSlug} name={link.openedEnvironmentName} />
          </p>
          <h1 className="claim">
            Paste <SealedName name={link.openedName} />
          </h1>
          {link.reason !== '' && <p className="paste-why">“{link.reason}”</p>}
          {link.hint !== '' && <p className="paste-hint">Where to find it: {link.hint}</p>}
          {isBlocked && (
            <p className="warnline">
              A name on this link does not open with your vault, so nothing can be saved for it.
            </p>
          )}
          <Form
            className="form-flow"
            onSubmit={event => {
              event.preventDefault();
              if (saving.waiting || value === '' || isBlocked) return;
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
            <TextAreaField
              label="Value"
              className="decide-field"
              rows={6}
              autoFocus={!isBlocked}
              disabled={isBlocked}
              hint={
                isBlocked
                  ? undefined
                  : 'Sealed in this browser to the environment’s key before it is sent. baymutt cannot read it, and this page will not show it again. Several lines are fine.'
              }
              failure={failureMessage(saving)}
              value={value}
              onValueChange={clearing(setValue)}
            />
            <Answer isSingle error={null}>
              <Button
                type="submit"
                size="lg"
                kind="primary"
                disabled={value === '' || isBlocked}
                isPending={saving.waiting}
                pendingLabel="Sealing…"
              >
                Seal and save
              </Button>
            </Answer>
          </Form>
        </DecisionColumn>
      ),
    };
  })();
  useTitle(screen.title, org?.name);

  // While checking, and once spent, missing or failed, no org is known: "baymutt" and no way back.
  const isResolved = target !== null && org !== undefined;
  return (
    <>
      <DecisionBar org={isResolved ? org : null} waitsUnder={isResolved ? 'paste-links' : null} />
      {screen.body}
    </>
  );
};
