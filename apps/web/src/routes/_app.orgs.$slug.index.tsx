import { createFileRoute, Navigate } from '@tanstack/react-router';

const Page = () => (
  <Navigate to="/orgs/$slug/environments" params={{ slug: Route.useParams().slug }} replace />
);

export const Route = createFileRoute('/_app/orgs/$slug/')({ component: Page });
