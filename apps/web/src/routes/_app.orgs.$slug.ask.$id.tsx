import { createFileRoute } from '@tanstack/react-router';
import { AskPlanPage } from '../pages/ask-plan.tsx';

// Keyed by the plan: another plan's page starts with its own focus, drafts and notes.
const Page = () => {
  const { id } = Route.useParams();
  return <AskPlanPage key={id} id={id} />;
};

export const Route = createFileRoute('/_app/orgs/$slug/ask/$id')({ component: Page });
