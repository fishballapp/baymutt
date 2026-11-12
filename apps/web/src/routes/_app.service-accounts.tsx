import { createFileRoute } from '@tanstack/react-router';
import { ServiceAccountsPage } from '../pages/service-accounts.tsx';

export const Route = createFileRoute('/_app/service-accounts')({ component: ServiceAccountsPage });
