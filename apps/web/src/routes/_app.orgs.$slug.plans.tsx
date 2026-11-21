import { createFileRoute } from '@tanstack/react-router';
import { PlansPage } from '../pages/plans.tsx';

export const Route = createFileRoute('/_app/orgs/$slug/plans')({ component: PlansPage });
