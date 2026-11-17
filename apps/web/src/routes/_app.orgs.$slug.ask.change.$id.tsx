import { createFileRoute } from '@tanstack/react-router';
import { AskChangePage } from '../pages/ask-change.tsx';

const Page = () => <AskChangePage id={Route.useParams().id} />;

export const Route = createFileRoute('/_app/orgs/$slug/ask/change/$id')({ component: Page });
