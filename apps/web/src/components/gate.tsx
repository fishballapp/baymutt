import { useAtom, useAtomValue } from '@effect/atom-react';
import * as AsyncResult from 'effect/reactivity/AsyncResult';
import * as Atom from 'effect/reactivity/Atom';
import { createContext, type ReactNode, use, useEffect, useState } from 'react';
import { orgsAtom, resumeAtom, sealOrgsAtom } from '../lib/data.ts';
import { type Owner, useOwnerStore } from '../lib/owner.ts';
import { failureMessage, latest } from '../lib/result.ts';
import { Entry, Standalone } from '../pages/entry.tsx';
import { RecoveryKey } from './recovery-key.tsx';
import { Button } from './ui/button.tsx';
import { Notice } from './ui/list.tsx';

const OwnerContext = createContext<Owner | null>(null);

/** The open vault. Only under `OwnerGate`, which renders nothing beneath it while the vault is locked. */
export const useOwner = (): Owner => {
  const owner = use(OwnerContext);
  if (owner === null) throw new Error('useOwner is only available under OwnerGate');
  return owner;
};

/**
 * Everything beneath it has the open vault. Until then it is the sign-in screen (unless this
 * browser kept the vault open, which a page load opens again by itself), and a vault that
 * was just made shows its recovery key before anything else.
 */
export const OwnerGate = ({ children }: { readonly children: ReactNode }) => {
  const owner = useOwnerStore(state => state.owner);
  const resuming = useAtomValue(resumeAtom);
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);

  if (recoveryKey !== null) {
    return (
      <Standalone>
        <RecoveryKey recoveryKey={recoveryKey} onDone={() => setRecoveryKey(null)} />
      </Standalone>
    );
  }
  if (owner === null) {
    // Nothing until the kept vault is open or known not to be: no flash of the unlock screen.
    if (AsyncResult.isInitial(resuming)) return null;
    return (
      <Standalone>
        <Entry onRecoveryKey={setRecoveryKey} />
      </Standalone>
    );
  }
  return <OwnerContext value={owner}>{children}</OwnerContext>;
};

/**
 * Seals the names of every org that has not sealed them yet, once the vault is open: the store
 * keeps an org's names as written until then, and nothing with a new name can be made in it.
 * Keyed on which orgs are unsealed, so a failure is not retried until that changes. A CLI login
 * or service account whose key cannot be verified is left out, and the owner is told which.
 * Called once for every page under the vault, decision pages included; answers the notice a shell
 * page shows above itself, or null.
 */
export const useNamesSealing = (): ReactNode => {
  const owner = useOwner();
  const [sealing, seal] = useAtom(sealOrgsAtom);
  const unsealed =
    latest(useAtomValue(orgsAtom))
      ?.filter(org => !org.areNamesSealed)
      .map(org => org.id)
      .join(' ') ?? '';
  useEffect(() => {
    if (unsealed !== '') seal(owner);
  }, [unsealed, owner, seal]);
  const failure = failureMessage(sealing);
  if (failure !== null) {
    return (
      <Notice tone="danger" className="notice-above">
        Couldn't seal the names in your orgs: {failure} It is tried again when you next open the
        dashboard.
      </Notice>
    );
  }
  const leftOut = AsyncResult.isSuccess(sealing) ? sealing.value : [];
  if (leftOut.length === 0) return null;
  return (
    <Notice tone="warn" className="notice-above">
      {leftOut.map(({ org, leftOut: names }) => (
        <span key={org}>
          The names in {org} are sealed. {names.join(', ')} {names.length === 1 ? 'was' : 'were'}{' '}
          left out: {names.length === 1 ? 'its' : 'their'} key cannot be verified, so{' '}
          {names.length === 1 ? 'it' : 'they'} cannot list the names there until replaced.{' '}
        </span>
      ))}
      <Button kind="quiet" onClick={() => seal(Atom.Reset)}>
        Dismiss
      </Button>
    </Notice>
  );
};
