import { createFileRoute } from '@tanstack/react-router';
import { AskCreateEnvironmentPage } from '../pages/ask-create-environment.tsx';

const Page = () => <AskCreateEnvironmentPage id={Route.useParams().id} />;

export const Route = createFileRoute('/_app/ask/create-environment/$id')({ component: Page });
