import { createFileRoute } from '@tanstack/react-router';
import { PairPage } from '../pages/pair.tsx';

export const Route = createFileRoute('/_app/pair')({ component: PairPage });
