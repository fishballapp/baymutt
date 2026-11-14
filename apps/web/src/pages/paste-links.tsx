import type { PasteLink } from '@baymutt/api';
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
import { addressOf, cancelPasteLinkAtom, pasteLinksAtom } from '../lib/data.ts';
import { failureMessage, latest } from '../lib/result.ts';

const Reason = ({ children }: { readonly children: string }) =>
  children === '' ? null : (
    <p className="mt-1.5 max-w-[65ch] border-line border-l pl-3 text-sm text-muted">{children}</p>
  );

const PasteRow = ({ link }: { readonly link: PasteLink }) => {
  const [cancelling, cancel] = useAtom(cancelPasteLinkAtom(link.id));
  return (
    <Row>
      <div className="flex flex-col gap-x-4 gap-y-3 sm:flex-row sm:items-start">
        <div className="min-w-0 flex-1">
          <p>
            <span className="font-medium">{link.createdBy.name}</span> asks you to paste{' '}
            <Code>{link.name}</Code> into{' '}
            <Code>{addressOf({ orgSlug: link.orgSlug, name: link.environmentName })}</Code>
          </p>
          <Reason>{link.reason}</Reason>
          {link.hint !== '' && (
            <p className="mt-1.5 text-sm">
              <span className="text-muted">Where to find it:</span> {link.hint}
            </p>
          )}
          <p className="mt-1.5 text-sm text-muted">
            asked <Time at={link.createdAt} />
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5 sm:shrink-0">
          <Link to="/paste/$id" params={{ id: link.id }} className={buttonStyles()}>
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

export const PasteLinksPage = () => {
  const result = useAtomValue(pasteLinksAtom);
  const paste = latest(result);
  const failure = failureMessage(result);
  return (
    <>
      <PageHeader
        title="Paste links"
        lede="Values your CLI logins and service accounts asked you to paste, in every org."
      />
      {failure && <Notice className="mb-6">{failure}</Notice>}
      {paste === null && !failure && <Skeleton rows={2} />}
      {paste?.length === 0 && (
        <Empty title="Nothing is waiting on you">
          <p>
            A paste link from <Code>baymutt paste-link</Code> asks for a value only you can fetch.
            It lands here.
          </p>
        </Empty>
      )}
      {paste !== null && paste.length > 0 && (
        <Rows>
          {paste.map(link => (
            <PasteRow key={link.id} link={link} />
          ))}
        </Rows>
      )}
    </>
  );
};
