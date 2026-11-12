import type { Machine } from '@baymutt/api';
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
import { machinesAtom, revokeMachineAtom } from '../lib/data.ts';
import { counted } from '../lib/format.ts';
import { failureMessage, latest } from '../lib/result.ts';

const MachineRow = ({
  machine,
  madeBy,
  made,
}: {
  readonly machine: Machine;
  readonly madeBy: string | undefined;
  readonly made: number;
}) => {
  const [revoking, revoke] = useAtom(revokeMachineAtom, { mode: 'promiseExit' });
  const [isConfirming, setIsConfirming] = useState(false);
  return (
    <Row>
      <div className="flex flex-col gap-x-4 gap-y-2 sm:flex-row sm:items-start">
        <div className="min-w-0 flex-1">
          <p className="font-medium">{machine.name}</p>
          <p className="mt-0.5 text-sm text-muted">
            {madeBy === undefined ? 'paired' : `made by ${madeBy}`} <Time at={machine.createdAt} />{' '}
            ·{' '}
            {machine.lastUsedAt === null ? (
              'never used'
            ) : (
              <>
                last used <Time at={machine.lastUsedAt} />
              </>
            )}
          </p>
          {machine.grants.length === 0 ? (
            <p className="mt-2 text-sm text-muted">No access to any project.</p>
          ) : (
            <ul className="mt-2 space-y-0.5 text-sm">
              {machine.grants.map(grant => (
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
            title={`Revoke ${machine.name}?`}
            keepLabel="Keep machine"
            confirmLabel="Revoke machine"
            pendingLabel="Revoking…"
            isDangerous
            isPending={revoking.waiting}
            error={failureMessage(revoking)}
            onConfirm={async () => {
              const exit = await revoke(machine.id);
              if (exit._tag === 'Success') setIsConfirming(false);
            }}
          >
            <p>
              Its key stops working at once
              {made > 0 && `, and so do the ${counted(made, 'machine')} it made`}.
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

export const MachinesPage = () => {
  const result = useAtomValue(machinesAtom);
  const machines = latest(result);
  return (
    <>
      <PageHeader
        title="Machines"
        lede="A machine is a laptop, an agent or a CI job with its own key. It reaches only the projects it was granted."
      />
      {failureMessage(result) && <Notice>{failureMessage(result)}</Notice>}
      {machines === null && !failureMessage(result) && <Skeleton />}
      {machines?.length === 0 && (
        <Empty title="No machines yet">
          <p>On the laptop, agent or CI runner, install the CLI and pair it:</p>
          <CommandLine>npm install -g baymutt</CommandLine>
          <CommandLine>baymutt pair --name "my laptop"</CommandLine>
          <p>
            It prints a link and a code. Open the link here and pair it if the codes match. A new
            machine starts with no access.
          </p>
        </Empty>
      )}
      {machines !== null && machines.length > 0 && (
        <Rows>
          {machines.map(machine => (
            <MachineRow
              key={machine.id}
              machine={machine}
              madeBy={machines.find(({ id }) => id === machine.parentId)?.name}
              made={machines.filter(({ parentId }) => parentId === machine.id).length}
            />
          ))}
        </Rows>
      )}
    </>
  );
};
