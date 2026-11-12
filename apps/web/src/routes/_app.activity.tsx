import { createFileRoute } from '@tanstack/react-router';
import { ActivityPage } from '../pages/activity.tsx';

export const Route = createFileRoute('/_app/activity')({ component: ActivityPage });
