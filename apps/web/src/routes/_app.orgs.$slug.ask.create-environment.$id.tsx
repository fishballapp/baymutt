import { createFileRoute } from '@tanstack/react-router';
import { AskCreateEnvironmentPage } from '../pages/ask-create-environment.tsx';

// Keyed by the ask: another ask's page starts with its own choices, not this one's.
const Page = () => {
  const { id } = Route.useParams();
  return <AskCreateEnvironmentPage key={id} id={id} />;
};

export const Route = createFileRoute('/_app/orgs/$slug/ask/create-environment/$id')({
  component: Page,
});
