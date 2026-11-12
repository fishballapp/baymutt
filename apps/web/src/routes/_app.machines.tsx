import { createFileRoute } from '@tanstack/react-router';
import { MachinesPage } from '../pages/machines.tsx';

export const Route = createFileRoute('/_app/machines')({ component: MachinesPage });
