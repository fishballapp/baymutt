import { createFileRoute } from '@tanstack/react-router';
import { RequestsPage } from '../pages/requests.tsx';

export const Route = createFileRoute('/_app/requests')({ component: RequestsPage });
