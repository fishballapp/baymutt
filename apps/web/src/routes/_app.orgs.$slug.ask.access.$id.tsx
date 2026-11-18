import { createFileRoute } from '@tanstack/react-router';
import { AskAccessPage } from '../pages/ask-access.tsx';

// Keyed by the ask: another ask's page starts with its own choices, not this one's.
const Page = () => {
  const { id } = Route.useParams();
  return <AskAccessPage key={id} id={id} />;
};

export const Route = createFileRoute('/_app/orgs/$slug/ask/access/$id')({ component: Page });
