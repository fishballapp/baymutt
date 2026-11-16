import { createFileRoute } from '@tanstack/react-router';
import { RequestPage } from '../pages/request.tsx';

const Page = () => <RequestPage id={Route.useParams().id} />;

export const Route = createFileRoute('/_app/requests/$id')({ component: Page });
