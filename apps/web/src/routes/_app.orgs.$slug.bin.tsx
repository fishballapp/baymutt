import { createFileRoute } from '@tanstack/react-router';
import { BinPage } from '../pages/bin.tsx';

export const Route = createFileRoute('/_app/orgs/$slug/bin')({ component: BinPage });
