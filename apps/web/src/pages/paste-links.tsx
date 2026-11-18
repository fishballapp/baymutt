import { useAtom, useAtomValue } from '@effect/atom-react';
import { Link } from '@tanstack/react-router';
import { useOwner } from '../components/gate.tsx';
import { useOrg } from '../components/org-scope.tsx';
import { useTitle } from '../components/shell.tsx';
import { buttonClass } from '../components/ui/button.tsx';
import { EmptyState, Notice, Skeleton } from '../components/ui/list.tsx';
import { RowMenu } from '../components/ui/menu.tsx';
import { PageHead, PageTitle } from '../components/ui/page.tsx';
import { Address, SealedName } from '../components/ui/text.tsx';
import { WaitingList, WaitingRow } from '../components/waiting.tsx';
import { cancelPasteLinkAtom, type OpenedPasteLink, pasteLinksAtom } from '../lib/data.ts';
import { failureMessage, latest } from '../lib/result.ts';

const PasteLinkRow = ({ link }: { readonly link: OpenedPasteLink }) => {
  const [dismissing, dismiss] = useAtom(cancelPasteLinkAtom(link.id));
  return (
    <WaitingRow
      ask={
        <>
          <b>{link.createdBy.name}</b> asks you to paste <SealedName name={link.openedName} /> into{' '}
          <Address orgSlug={link.orgSlug} name={link.openedEnvironmentName} />
        </>
      }
      reason={link.reason === '' ? null : link.reason}
      about={link.hint === '' ? [] : [`Where to find it: ${link.hint}`]}
      askedAt={link.createdAt}
      action={
        <Link to="/paste/$id" params={{ id: link.id }} className={buttonClass()}>
          Paste value
        </Link>
      }
      menu={
        <RowMenu
          label={`${link.openedName ?? 'this secret'}: dismiss`}
          isDisabled={dismissing.waiting}
          items={[{ label: 'Dismiss', onClick: () => dismiss() }]}
        />
      }
      working={dismissing.waiting ? 'Dismissing…' : null}
      error={failureMessage(dismissing)}
    />
  );
};

export const PasteLinksPage = () => {
  const org = useOrg();
  useTitle('Paste links', org.name);
  const result = useAtomValue(pasteLinksAtom(useOwner()));
  const failure = failureMessage(result);
  const links =
    latest(result)
      ?.filter(link => link.orgId === org.id)
      .toSorted((a, b) => b.createdAt - a.createdAt) ?? null;
  const body = (() => {
    if (failure !== null) return <Notice tone="danger">{failure}</Notice>;
    if (links === null) return <Skeleton />;
    if (links.length === 0) {
      return (
        <EmptyState
          example={{
            lead: 'An agent asks for one like this:',
            commands: [
              `baymutt ask paste-link ${org.slug}/app/production RESEND_API_KEY --reason "send sign-in emails"`,
            ],
          }}
        >
          When an agent needs a value only you can fetch, its paste link waits here.
        </EmptyState>
      );
    }
    return (
      <WaitingList>
        {links.map(link => (
          <PasteLinkRow key={link.id} link={link} />
        ))}
      </WaitingList>
    );
  })();
  return (
    <>
      <PageHead title={<PageTitle>Paste links</PageTitle>} />
      {body}
    </>
  );
};
