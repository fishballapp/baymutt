import { createFileRoute, Outlet } from '@tanstack/react-router';
import { OrgScope } from '../components/orgs.tsx';

// The org in the address is the one every page under it shows.
const Scope = () => (
  <OrgScope slug={Route.useParams().slug}>
    <Outlet />
  </OrgScope>
);

export const Route = createFileRoute('/_app/orgs/$slug')({ component: Scope });
