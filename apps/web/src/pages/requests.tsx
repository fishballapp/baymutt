import type { AccessRequest, PasteRequest, Project } from '@baymutt/api';
import { useAtom, useAtomValue } from '@effect/atom-react';
import { Link } from '@tanstack/react-router';
import { useOwner } from '../components/gate.tsx';
import {
  Code,
  Empty,
  grantWords,
  Notice,
  PageHeader,
  Row,
  Rows,
  Section,
  Skeleton,
  Time,
} from '../components/parts.tsx';
import { Button, buttonStyles } from '../components/ui/button.tsx';
import {
  accessRequestsAtom,
  approveAccessAtom,
  cancelPasteAtom,
  denyAccessAtom,
  pasteRequestsAtom,
  projectsAtom,
} from '../lib/data.ts';
import { failureMessage, latest } from '../lib/result.ts';

const Reason = ({ children }: { readonly children: string }) =>
  children === '' ? null : (
    <p className="mt-1.5 max-w-[65ch] border-line border-l pl-3 text-sm text-muted">{children}</p>
  );

const AccessRow = ({
  request,
  project,
}: {
  readonly request: AccessRequest;
  readonly project: Project | undefined;
}) => {
  const owner = useOwner();
  const [approving, approve] = useAtom(approveAccessAtom(request.id));
  const [denying, deny] = useAtom(denyAccessAtom(request.id));
  const wants = grantWords({ canRead: request.wantsRead, canWrite: request.wantsWrite });
  // A grant is sealed to the machine's key, and the vault only vouches for the key of a machine
  // the owner paired.
  const cannotRead = request.endorsement === null;
  const isBusy = approving.waiting || denying.waiting;
  const failure = failureMessage(approving) ?? failureMessage(denying);
  return (
    <Row>
      <div className="flex flex-col gap-x-4 gap-y-3 sm:flex-row sm:items-start">
        <div className="min-w-0 flex-1">
          <p>
            <span className="font-medium">{request.credentialName}</span> asks to{' '}
            <span className="font-medium">{wants}</span> <Code>{request.projectName}</Code>
          </p>
          <Reason>{request.reason}</Reason>
          <p className="mt-1.5 text-sm text-muted">
            asked <Time at={request.createdAt} />
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5 sm:shrink-0">
          <Button
            disabled={isBusy || cannotRead || project === undefined}
            onClick={() => project && approve({ owner, request, project })}
          >
            {approving.waiting ? 'Approving…' : `Approve ${wants}`}
          </Button>
          <Button disabled={isBusy} onClick={() => deny()}>
            {denying.waiting ? 'Denying…' : 'Deny'}
          </Button>
        </div>
      </div>
      {cannotRead && (
        <Notice tone="plain" className="mt-3">
          This machine was made by another machine, so nothing here vouches for its key. The machine
          that made it can hand it access; you can deny this.
        </Notice>
      )}
      {request.wantsRead && !cannotRead && (
        <p className="mt-3 text-sm text-muted">
          Approving wraps the project key to this machine. What it reads afterwards cannot be
          unread.
        </p>
      )}
      {failure && <Notice className="mt-3">{failure}</Notice>}
    </Row>
  );
};

const PasteRow = ({ request }: { readonly request: PasteRequest }) => {
  const [cancelling, cancel] = useAtom(cancelPasteAtom(request.id));
  return (
    <Row>
      <div className="flex flex-col gap-x-4 gap-y-3 sm:flex-row sm:items-start">
        <div className="min-w-0 flex-1">
          <p>
            <span className="font-medium">{request.createdBy.name}</span> asks you to paste{' '}
            <Code>{request.name}</Code> into <Code>{request.projectName}</Code>
          </p>
          <Reason>{request.reason}</Reason>
          {request.hint !== '' && (
            <p className="mt-1.5 text-sm">
              <span className="text-muted">Where to find it:</span> {request.hint}
            </p>
          )}
          <p className="mt-1.5 text-sm text-muted">
            asked <Time at={request.createdAt} />
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5 sm:shrink-0">
          <Link to="/paste/$id" params={{ id: request.id }} className={buttonStyles()}>
            Paste value
          </Link>
          <Button disabled={cancelling.waiting} onClick={() => cancel()}>
            {cancelling.waiting ? 'Dismissing…' : 'Dismiss'}
          </Button>
        </div>
      </div>
      {failureMessage(cancelling) && <Notice className="mt-3">{failureMessage(cancelling)}</Notice>}
    </Row>
  );
};

export const RequestsPage = () => {
  const accessResult = useAtomValue(accessRequestsAtom);
  const pasteResult = useAtomValue(pasteRequestsAtom);
  const access = latest(accessResult);
  const paste = latest(pasteResult);
  const projects = latest(useAtomValue(projectsAtom)) ?? [];
  const failure = failureMessage(accessResult) ?? failureMessage(pasteResult);
  const isEmpty = access?.length === 0 && paste?.length === 0;
  return (
    <>
      <PageHeader
        title="Requests"
        lede="What your machines are waiting on you for. Everything else they do without asking."
      />
      {failure && <Notice className="mb-6">{failure}</Notice>}
      {(access === null || paste === null) && !failure && <Skeleton rows={2} />}
      {isEmpty && (
        <Empty title="Nothing is waiting on you">
          <p>
            A machine asks for access with <Code>baymutt access request</Code>, and for a value only
            you can fetch with <Code>baymutt request</Code>. Both land here.
          </p>
        </Empty>
      )}
      {access !== null && access.length > 0 && (
        <Section title="Access">
          <Rows>
            {access.map(request => (
              <AccessRow
                key={request.id}
                request={request}
                project={projects.find(({ id }) => id === request.projectId)}
              />
            ))}
          </Rows>
        </Section>
      )}
      {paste !== null && paste.length > 0 && (
        <Section title="Values to paste">
          <Rows>
            {paste.map(request => (
              <PasteRow key={request.id} request={request} />
            ))}
          </Rows>
        </Section>
      )}
    </>
  );
};
