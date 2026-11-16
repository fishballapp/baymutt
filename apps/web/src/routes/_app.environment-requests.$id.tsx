import { createFileRoute } from '@tanstack/react-router';
import { EnvironmentRequestPage } from '../pages/environment-request.tsx';

const Page = () => <EnvironmentRequestPage id={Route.useParams().id} />;

export const Route = createFileRoute('/_app/environment-requests/$id')({ component: Page });
