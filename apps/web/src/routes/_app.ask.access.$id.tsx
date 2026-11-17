import { createFileRoute } from '@tanstack/react-router';
import { AskAccessPage } from '../pages/ask-access.tsx';

const Page = () => <AskAccessPage id={Route.useParams().id} />;

export const Route = createFileRoute('/_app/ask/access/$id')({ component: Page });
