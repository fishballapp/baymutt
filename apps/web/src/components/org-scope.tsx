// The org an address names (`/orgs/<slug>/…`), the scope it gives every page under it, and the
// org the dashboard opens on.
import type { Org } from '@baymutt/api';
import { useAtomValue } from '@effect/atom-react';
import { Link } from '@tanstack/react-router';
import { createContext, type ReactNode, use, useEffect } from 'react';
import { orgsAtom } from '../lib/data.ts';
import { failureMessage, latest } from '../lib/result.ts';
import { DecisionLoading, Outcome } from './decision/frame.tsx';
import { buttonClass } from './ui/button.tsx';
import { Missing, Skeleton } from './ui/list.tsx';

/** Holds a slug. A new name: `baymutt.org` held an org's id before 0.10.0. */
const LAST_ORG = 'baymutt.lastOrgSlug';

/**
 * The org the dashboard opens on: the one this browser last showed, else the first. The address
 * decides which org a page shows; this decides only where `/orgs` and the wordmark land.
 */
export const homeOrg = (orgs: ReadonlyArray<Org>): Org | null =>
  orgs.find(org => org.slug === localStorage.getItem(LAST_ORG)) ?? orgs[0] ?? null;

const OrgContext = createContext<Org | null>(null);

/** The org the address names. Only under `OrgScope`, which renders nothing beneath it for any other. */
export const useOrg = (): Org => {
  const org = use(OrgContext);
  if (org === null) throw new Error('useOrg is only available under OrgScope');
  return org;
};

/**
 * Everything under `/orgs/<slug>`: the person's org with that slug, or a page that says there is
 * none, with a way back. Under a decision page (`isDecision`) loading and "No org here" stay in the
 * decision frame: four skeleton rows, or an outcome.
 */
export const OrgScope = ({
  slug,
  isDecision,
  children,
}: {
  readonly slug: string;
  readonly isDecision: boolean;
  readonly children: ReactNode;
}) => {
  const result = useAtomValue(orgsAtom);
  const orgs = latest(result);
  const org = orgs?.find(listed => listed.slug === slug);
  useEffect(() => {
    if (org !== undefined) localStorage.setItem(LAST_ORG, org.slug);
  }, [org]);
  const failure = orgs === null ? failureMessage(result) : null;
  // An org just created is not in the list until it has been read again.
  const isLoading = (orgs === null && failure === null) || (org === undefined && result.waiting);
  if (isLoading) return isDecision ? <DecisionLoading /> : <Skeleton />;
  if (failure !== null) {
    return isDecision ? (
      <Outcome title="Couldn't load your orgs" tone="danger">
        {failure}
      </Outcome>
    ) : (
      <Missing title="Couldn't load your orgs" isFailure>
        {failure}
      </Missing>
    );
  }
  if (org === undefined) {
    const sentence = (
      <>
        None of your orgs has the slug <span className="code">{slug}</span>.
      </>
    );
    const wayBack = (
      <Link to="/orgs" className={buttonClass({ size: isDecision ? 'lg' : 'md' })}>
        Go to your orgs
      </Link>
    );
    return isDecision ? (
      <Outcome title="No org here" action={wayBack}>
        {sentence}
      </Outcome>
    ) : (
      <Missing title="No org here" action={wayBack}>
        {sentence}
      </Missing>
    );
  }
  return <OrgContext value={org}>{children}</OrgContext>;
};
