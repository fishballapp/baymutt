import { createFileRoute } from '@tanstack/react-router';
import { KeysPage } from '../pages/keys.tsx';

export const Route = createFileRoute('/_app/orgs/$slug/keys')({ component: KeysPage });
