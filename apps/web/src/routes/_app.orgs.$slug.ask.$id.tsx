import { createFileRoute } from '@tanstack/react-router';
import { AskPage } from '../pages/ask.tsx';

// Keyed by the ask: another ask's page starts with its own focus, drafts and notes.
const Page = () => {
  const { id } = Route.useParams();
  return <AskPage key={id} id={id} />;
};

export const Route = createFileRoute('/_app/orgs/$slug/ask/$id')({ component: Page });
