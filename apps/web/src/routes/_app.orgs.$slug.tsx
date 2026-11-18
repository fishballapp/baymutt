import { createFileRoute, Outlet, useRouterState } from '@tanstack/react-router';
import { OrgScope } from '../components/org-scope.tsx';
import { isDecisionPath } from '../components/shell.tsx';

// The org in the address is the one every page under it shows. An ask page answers in the
// decision frame, so its loading and "No org here" do too.
const Scope = () => {
  const isDecision = useRouterState({ select: state => isDecisionPath(state.location.pathname) });
  return (
    <OrgScope slug={Route.useParams().slug} isDecision={isDecision}>
      <Outlet />
    </OrgScope>
  );
};

export const Route = createFileRoute('/_app/orgs/$slug')({ component: Scope });
