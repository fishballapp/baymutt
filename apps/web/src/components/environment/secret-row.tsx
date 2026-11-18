// A secret as a row of its environment: its value in place, its Replace form and its History.

import { useAtom, useAtomSet, useAtomValue } from '@effect/atom-react';
import * as Atom from 'effect/reactivity/Atom';
import { type AnimationEvent, useEffect, useLayoutEffect, useState } from 'react';
import {
  type OpenedEnvironment,
  type OpenedSecret,
  removeSecretAtom,
  revealSecretAtom,
  rollbackSecretAtom,
  versionsAtom,
  writeSecretAtom,
} from '../../lib/data.ts';
import { bytes } from '../../lib/format.ts';
import { clearsFailure, failureMessage, latest } from '../../lib/result.ts';
import { useOwner } from '../gate.tsx';
import { Button } from '../ui/button.tsx';
import { Confirm } from '../ui/dialog.tsx';
import { ActionForm, useInlineForm } from '../ui/form.tsx';
import { Row, Status } from '../ui/list.tsx';
import { RowMenu } from '../ui/menu.tsx';
import { RelativeTime } from '../ui/page.tsx';
import { SecretValue, SecretValueActions, useSecretValue } from '../ui/secret-value.tsx';
import { SealedName } from '../ui/text.tsx';
import { ValueField } from './value-field.tsx';

/**
 * Opens the current value in this browser, as a promise. Nothing keeps it here: the atom is reset
 * as soon as the value is handed over, and when the row leaves the page.
 */
const useOpenValue = ({
  environment,
  secret,
  openedName,
  version,
}: {
  readonly environment: OpenedEnvironment;
  readonly secret: OpenedSecret;
  readonly openedName: string;
  readonly version: number;
}) => {
  const owner = useOwner();
  const atom = revealSecretAtom(`${environment.id}/${secret.name}`);
  const run = useAtomSet(atom, { mode: 'promise' });
  // A plain setter for resets: in promise mode a reset would wait on a result that never comes.
  const forget = useAtomSet(atom);
  useEffect(() => () => forget(Atom.Reset), [forget]);
  return async () => {
    try {
      return await run({
        owner,
        environmentId: environment.id,
        name: secret.name,
        openedName,
        version,
      });
    } finally {
      forget(Atom.Reset);
    }
  };
};

/** Its versions, newest first, in a panel straight under its row. */
const History = ({
  environment,
  secret,
  onClose,
}: {
  readonly environment: OpenedEnvironment;
  readonly secret: OpenedSecret;
  readonly onClose: () => void;
}) => {
  const key = { environmentId: environment.id, name: secret.name };
  const result = useAtomValue(versionsAtom(key));
  const versions = latest(result);
  const [rolling, rollback] = useAtom(rollbackSecretAtom);
  const [making, setMaking] = useState<number | null>(null);
  const error = failureMessage(result) ?? failureMessage(rolling);
  return (
    <li className="panel-row">
      <div className="panel">
        {versions === null && error === null && (
          <p className="t-small muted">Loading its versions…</p>
        )}
        {versions !== null && (
          <ul className="versions">
            {versions.map(version => (
              <li key={version.version}>
                <b>v{version.version}</b>
                <span className="facts">
                  {bytes(version.size)}, {version.createdBy.name},{' '}
                  <RelativeTime at={version.createdAt} />
                </span>
                {version.isCurrent ? (
                  <span className="current">current</span>
                ) : (
                  <Button
                    kind="quiet"
                    isPending={rolling.waiting && making === version.version}
                    pendingLabel="Making it current…"
                    disabled={rolling.waiting}
                    onClick={() => {
                      setMaking(version.version);
                      rollback({ ...key, version: version.version });
                    }}
                  >
                    Make v{version.version} current
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {error !== null && (
          <p role="alert" className="row-error">
            {error}
          </p>
        )}
        <p className="panel-close">
          <Button kind="quiet" onClick={onClose}>
            Close
          </Button>
        </p>
      </div>
    </li>
  );
};

/** A new value for a secret, in a form straight under its row. */
const ReplaceForm = ({
  environment,
  name,
  onClose,
}: {
  readonly environment: OpenedEnvironment;
  readonly name: string;
  readonly onClose: () => void;
}) => {
  const owner = useOwner();
  const [writing, write] = useAtom(writeSecretAtom, { mode: 'promiseExit' });
  const forget = useAtomSet(writeSecretAtom);
  // One atom serves Add a secret and every Replace: another form's failure is not this one's.
  useLayoutEffect(() => {
    forget(Atom.Reset);
  }, [forget]);
  const clearing = clearsFailure(writing, forget);
  const [value, setValue] = useState('');
  return (
    <ActionForm
      placement="row"
      submitLabel="Seal and save"
      pendingLabel="Sealing…"
      isPending={writing.waiting}
      isSubmitDisabled={value === ''}
      onSubmit={async () => {
        const exit = await write({ owner, environment, name, value });
        if (exit._tag === 'Success') onClose();
      }}
      onCancel={onClose}
    >
      <ValueField
        label={`New value for ${name}`}
        failure={failureMessage(writing)}
        value={value}
        onValueChange={clearing(setValue)}
      />
    </ActionForm>
  );
};

/**
 * One secret: its name, its value sealed or revealed in place with Reveal or Hide and Copy, when
 * its current version was written, and its `⋯` (Replace, History, Delete). A name that does not
 * open has no value or Replace.
 */
export const SecretRow = ({
  environment,
  secret,
  version,
  flash,
}: {
  readonly environment: OpenedEnvironment;
  readonly secret: OpenedSecret;
  /** Its current version: a deleted secret is in the Bin, not here. */
  readonly version: number;
  readonly flash: {
    readonly isJustWritten: boolean;
    readonly onAnimationEnd: (event: AnimationEvent) => void;
  };
  /** Its Replace form opens: the page head hides its primary while it is open. */
}) => {
  const { openedName } = secret;
  const replace = useInlineForm(`replace:${secret.name}`);
  const history = useInlineForm(`history:${secret.name}`);
  const [removing, remove] = useAtom(removeSecretAtom, { mode: 'promiseExit' });
  // One atom serves every row: an earlier row's failure is not this dialog's.
  const forgetRemoving = useAtomSet(removeSecretAtom);
  const [isConfirming, setConfirming] = useState(false);
  const shownName = openedName ?? 'this secret';
  // Never opened for a name that does not open: its row shows no value or actions.
  const value = useSecretValue({
    name: shownName,
    version,
    open: useOpenValue({ environment, secret, openedName: openedName ?? '', version }),
  });
  return (
    <>
      <Row variant="row-secret" {...flash} error={value.error}>
        <span className="name">
          {openedName === null ? <SealedName name={null} /> : openedName}
        </span>
        {openedName !== null && (
          <>
            <SecretValue state={value} />
            <SecretValueActions state={value} />
          </>
        )}
        <Status status={<RelativeTime at={secret.updatedAt} />} />
        <RowMenu
          label={[
            shownName,
            ': ',
            [
              ...(openedName === null ? [] : ['replace']),
              history.isOpen ? 'hide history' : 'history',
              'delete',
            ].join(', '),
          ].join('')}
          items={[
            ...(openedName === null ? [] : [{ label: 'Replace', onClick: replace.open }]),
            history.isOpen
              ? { label: 'Hide history', onClick: history.close }
              : { label: 'History', onClick: history.open },
            { label: 'Delete', isDanger: true, onClick: () => setConfirming(true) },
          ]}
        />
      </Row>
      {replace.isOpen && openedName !== null && (
        <ReplaceForm environment={environment} name={openedName} onClose={replace.close} />
      )}
      {history.isOpen && (
        <History environment={environment} secret={secret} onClose={history.close} />
      )}
      <Confirm
        open={isConfirming}
        onOpenChange={setConfirming}
        onOpen={() => forgetRemoving(Atom.Reset)}
        title={`Delete ${shownName}?`}
        keepLabel="Keep it"
        confirmLabel="Delete secret"
        pendingLabel="Deleting…"
        isPending={removing.waiting}
        error={failureMessage(removing)}
        onConfirm={async () => {
          const exit = await remove({ environmentId: environment.id, name: secret.name });
          if (exit._tag === 'Success') setConfirming(false);
        }}
      >
        <p>
          Keys stop receiving it on their next load. It stays in the Bin for 30 days, where you can
          restore it.
        </p>
      </Confirm>
    </>
  );
};
