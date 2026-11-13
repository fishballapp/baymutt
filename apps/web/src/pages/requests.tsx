import type { PasteRequest } from '@baymutt/api';
import { useAtom, useAtomValue } from '@effect/atom-react';
import { Link } from '@tanstack/react-router';
import {
  Code,
  Empty,
  Notice,
  PageHeader,
  Row,
  Rows,
  Skeleton,
  Time,
} from '../components/parts.tsx';
import { Button, buttonStyles } from '../components/ui/button.tsx';
import { cancelPasteAtom, pasteRequestsAtom } from '../lib/data.ts';
import { failureMessage, latest } from '../lib/result.ts';

const Reason = ({ children }: { readonly children: string }) =>
  children === '' ? null : (
    <p className="mt-1.5 max-w-[65ch] border-line border-l pl-3 text-sm text-muted">{children}</p>
  );

const PasteRow = ({ request }: { readonly request: PasteRequest }) => {
  const [cancelling, cancel] = useAtom(cancelPasteAtom(request.id));
  return (
    <Row>
      <div className="flex flex-col gap-x-4 gap-y-3 sm:flex-row sm:items-start">
        <div className="min-w-0 flex-1">
          <p>
            <span className="font-medium">{request.createdBy.name}</span> asks you to paste{' '}
            <Code>{request.name}</Code> into <Code>{request.environmentName}</Code>
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
  const result = useAtomValue(pasteRequestsAtom);
  const paste = latest(result);
  const failure = failureMessage(result);
  return (
    <>
      <PageHeader
        title="Requests"
        lede="Values your service accounts asked you to paste. Everything else they do without asking."
      />
      {failure && <Notice className="mb-6">{failure}</Notice>}
      {paste === null && !failure && <Skeleton rows={2} />}
      {paste?.length === 0 && (
        <Empty title="Nothing is waiting on you">
          <p>
            An agent asks for a value only you can fetch with <Code>baymutt request</Code>. It lands
            here.
          </p>
        </Empty>
      )}
      {paste !== null && paste.length > 0 && (
        <Rows>
          {paste.map(request => (
            <PasteRow key={request.id} request={request} />
          ))}
        </Rows>
      )}
    </>
  );
};
