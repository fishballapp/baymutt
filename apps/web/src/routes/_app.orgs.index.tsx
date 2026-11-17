import { createFileRoute } from '@tanstack/react-router';
import { OrgsHome } from '../components/orgs.tsx';

export const Route = createFileRoute('/_app/orgs/')({ component: OrgsHome });
