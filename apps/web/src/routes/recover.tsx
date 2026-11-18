import { createFileRoute } from '@tanstack/react-router';
import { RecoverPage } from '../pages/recover.tsx';

export const Route = createFileRoute('/recover')({ component: RecoverPage });
