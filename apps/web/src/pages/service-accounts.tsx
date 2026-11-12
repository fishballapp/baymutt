import type { ServiceAccount } from '@baymutt/api';
import { useAtom, useAtomValue } from '@effect/atom-react';
import { useState } from 'react';
import {
  Code,
  CommandLine,
  Empty,
  grantWords,
  Notice,
  PageHeader,
  Row,
  RowActions,
  Rows,
  Skeleton,
  Time,
} from '../components/parts.tsx';
import { Button } from '../components/ui/button.tsx';
import { Confirm } from '../components/ui/confirm.tsx';
import { revokeServiceAccountAtom, serviceAccountsAtom } from '../lib/data.ts';
import { counted } from '../lib/format.ts';
import { failureMessage, latest } from '../lib/result.ts';

const ServiceAccountRow = ({
  serviceAccount,
  madeBy,
  made,
}: {
  readonly serviceAccount: ServiceAccount;
  readonly madeBy: string | undefined;
  readonly made: number;
}) => {
  const [revoking, revoke] = useAtom(revokeServiceAccountAtom, { mode: 'promiseExit' });
  const [isConfirming, setIsConfirming] = useState(false);
  return (
    <Row>
      <div className="flex flex-col gap-x-4 gap-y-2 sm:flex-row sm:items-start">
        <div className="min-w-0 flex-1">
          <p className="font-medium">{serviceAccount.name}</p>
          <p className="mt-0.5 text-sm text-muted">
            {madeBy === undefined ? 'logged in' : `made by ${madeBy}`}{' '}
            <Time at={serviceAccount.createdAt} /> ·{' '}
            {serviceAccount.lastUsedAt === null ? (
              'never used'
            ) : (
              <>
                last used <Time at={serviceAccount.lastUsedAt} />
              </>
            )}
          </p>
          {serviceAccount.grants.length === 0 ? (
            <p className="mt-2 text-sm text-muted">No access to any project.</p>
          ) : (
            <ul className="mt-2 space-y-0.5 text-sm">
              {serviceAccount.grants.map(grant => (
                <li key={grant.projectId}>
                  <span className="text-muted">can {grantWords(grant)}</span>{' '}
                  <Code>{grant.projectName}</Code>
                </li>
              ))}
            </ul>
          )}
        </div>
        <RowActions>
          <Confirm
            open={isConfirming}
            onOpenChange={setIsConfirming}
            trigger={
              <Button size="sm" intent="subtleDanger">
                Revoke
              </Button>
            }
            title={`Revoke ${serviceAccount.name}?`}
            keepLabel="Keep service account"
            confirmLabel="Revoke service account"
            pendingLabel="Revoking…"
            isDangerous
            isPending={revoking.waiting}
            error={failureMessage(revoking)}
            onConfirm={async () => {
              const exit = await revoke(serviceAccount.id);
              if (exit._tag === 'Success') setIsConfirming(false);
            }}
          >
            <p>
              Its key stops working at once
              {made > 0 && `, and so do the ${counted(made, 'service account')} it made`}.
            </p>
            <p>
              What it already read stays read. If the key may have leaked, replace those values at
              their vendors too.
            </p>
          </Confirm>
        </RowActions>
      </div>
    </Row>
  );
};

export const ServiceAccountsPage = () => {
  const result = useAtomValue(serviceAccountsAtom);
  const serviceAccounts = latest(result);
  return (
    <>
      <PageHeader
        title="Service accounts"
        lede="A service account is an identity with its own key that agents and CI jobs act as. It reaches only the projects it was granted."
      />
      {failureMessage(result) && <Notice>{failureMessage(result)}</Notice>}
      {serviceAccounts === null && !failureMessage(result) && <Skeleton />}
      {serviceAccounts?.length === 0 && (
        <Empty title="No service accounts yet">
          <p>Install the CLI where the agent or CI job runs, and log in:</p>
          <CommandLine>npm install -g baymutt</CommandLine>
          <CommandLine>baymutt login --name "my laptop"</CommandLine>
          <p>
            It prints a link and a code. Open the link here and approve it if the codes match. A new
            service account starts with no access.
          </p>
        </Empty>
      )}
      {serviceAccounts !== null && serviceAccounts.length > 0 && (
        <Rows>
          {serviceAccounts.map(serviceAccount => (
            <ServiceAccountRow
              key={serviceAccount.id}
              serviceAccount={serviceAccount}
              madeBy={serviceAccounts.find(({ id }) => id === serviceAccount.parentId)?.name}
              made={serviceAccounts.filter(({ parentId }) => parentId === serviceAccount.id).length}
            />
          ))}
        </Rows>
      )}
    </>
  );
};
