import { createFileRoute } from '@tanstack/react-router';
import { ProjectsPage } from '../pages/projects.tsx';

export const Route = createFileRoute('/_app/projects/')({ component: ProjectsPage });
