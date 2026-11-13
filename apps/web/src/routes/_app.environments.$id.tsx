import { createFileRoute } from '@tanstack/react-router';
import { EnvironmentPage } from '../pages/environment.tsx';

const Page = () => <EnvironmentPage id={Route.useParams().id} />;

export const Route = createFileRoute('/_app/environments/$id')({ component: Page });
