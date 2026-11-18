import { createFileRoute } from '@tanstack/react-router';
import { AskChangePage } from '../pages/ask-change.tsx';

// Keyed by the ask: another ask's page starts with its own choices, not this one's.
const Page = () => {
  const { id } = Route.useParams();
  return <AskChangePage key={id} id={id} />;
};

export const Route = createFileRoute('/_app/orgs/$slug/ask/change/$id')({ component: Page });
