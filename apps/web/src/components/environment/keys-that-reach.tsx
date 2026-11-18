// "Keys that reach it": the active keys holding an environment, and taking that access away.

import { useAtom, useAtomValue } from '@effect/atom-react';
import { useState } from 'react';
import {
  hasEnded,
  isLogin,
  type OpenedEnvironment,
  type OpenedGrant,
  type OpenedServiceAccount,
  removeGrantAtom,
  serviceAccountsAtom,
} from '../../lib/data.ts';
import { expiryWords } from '../../lib/format.ts';
import { failureMessage, latest } from '../../lib/result.ts';
import { useOwner } from '../gate.tsx';
import { AccessDialog } from '../keys.tsx';
import { EmptyState, List, Notice, Row, Rows, Skeleton, Status } from '../ui/list.tsx';
import { RowMenu } from '../ui/menu.tsx';
import { RelativeTime } from '../ui/page.tsx';
import { AccessWords } from '../ui/text.tsx';

/**
 * Its name, what it holds here, its end, and its `⋯`: Change access opens the key's access dialog;
 * Remove access acts at once.
 */
const ReachRow = ({
  environment,
  serviceAccount,
  maker,
  grant,
}: {
  readonly environment: OpenedEnvironment;
  readonly serviceAccount: OpenedServiceAccount;
  /** The CLI login that asked for it, which vouched for its key. */
  readonly maker: OpenedServiceAccount | undefined;
  readonly grant: OpenedGrant;
}) => {
  const [isAccessOpen, setAccessOpen] = useState(false);
  const [removing, remove] = useAtom(removeGrantAtom);
  // One atom serves every row: only the row that asked shows its run and its failure.
  // ponytail: two rows removed at the same moment would each show the later run; un-park when seen.
  const [hasAsked, setAsked] = useState(false);
  const { expiresAt } = serviceAccount;
  return (
    <Row
      variant="row-reach"
      working={hasAsked && removing.waiting ? 'Removing…' : null}
      error={hasAsked ? failureMessage(removing) : null}
    >
      <b>{serviceAccount.name}</b>
      <span className="access">
        <AccessWords canRead={grant.canRead} canWrite={grant.canWrite} />
      </span>
      <Status
        status={
          expiresAt === null ? (
            expiryWords(null, Date.now())
          ) : (
            <RelativeTime at={expiresAt}>{() => expiryWords(expiresAt, Date.now())}</RelativeTime>
          )
        }
      />
      <RowMenu
        label={`${serviceAccount.name}: change access, remove access`}
        isDisabled={hasAsked && removing.waiting}
        items={[
          { label: 'Change access', onClick: () => setAccessOpen(true) },
          {
            label: 'Remove access',
            isDanger: true,
            onClick: () => {
              setAsked(true);
              remove({ id: environment.id, credentialId: serviceAccount.id });
            },
          },
        ]}
      />
      <AccessDialog
        keyToChange={serviceAccount}
        maker={maker}
        isOpen={isAccessOpen}
        onOpenChange={setAccessOpen}
      />
    </Row>
  );
};

/** Keys whose end has not passed and that hold this environment, by name. */
export const KeysThatReach = ({ environment }: { readonly environment: OpenedEnvironment }) => {
  const result = useAtomValue(serviceAccountsAtom(useOwner()));
  const now = Date.now();
  const keys = latest(result);
  const reaching =
    keys
      ?.filter(key => !isLogin(key) && !hasEnded(key, now))
      .flatMap(serviceAccount => {
        const grant = serviceAccount.grants.find(held => held.environmentId === environment.id);
        return grant === undefined ? [] : [{ serviceAccount, grant }];
      })
      .toSorted((a, b) => a.serviceAccount.name.localeCompare(b.serviceAccount.name)) ?? null;
  const failure = failureMessage(result);
  return (
    <List title="Keys that reach it">
      {(() => {
        if (reaching === null && failure !== null) return <Notice tone="danger">{failure}</Notice>;
        if (reaching === null) return <Skeleton />;
        if (reaching.length === 0) {
          return (
            <EmptyState>
              Only you, so far. A key reaches it once you approve a request that names it.
            </EmptyState>
          );
        }
        return (
          <Rows>
            {reaching.map(({ serviceAccount, grant }) => (
              <ReachRow
                key={serviceAccount.id}
                environment={environment}
                serviceAccount={serviceAccount}
                maker={keys?.find(key => key.id === serviceAccount.parentId)}
                grant={grant}
              />
            ))}
          </Rows>
        );
      })()}
    </List>
  );
};
