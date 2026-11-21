import { createFileRoute } from '@tanstack/react-router';
import { AsksPage } from '../pages/asks.tsx';

export const Route = createFileRoute('/_app/orgs/$slug/asks')({ component: AsksPage });
